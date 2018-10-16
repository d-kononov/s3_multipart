module S3Multipart

  # Collection of methods to be mixed in to the Upload class.
  # Handle all communication with Amazon S3 servers
  module TransferHelpers

    def initiate(options)
      url = "/#{unique_name(options)}?uploads"
      headers = {content_type: options[:content_type]}
      headers['X-Amz-Content-Sha256'] = options[:hash]

      headers.merge!(options[:headers]) if options.key?(:headers)
      authorization, amzdate = sign_request verb: 'POST',
                                        url: url,
                                        hash: options[:hash],
                                        host: get_host(),
                                        content_type: options[:content_type],
                                        headers: options[:headers]

      headers['X-Amz-Date'] = amzdate
      headers[:authorization] = authorization
      response = Http.post url, headers: headers
      parsed_response_body = XmlSimple.xml_in(response.body)
      { "key"  => parsed_response_body["Key"][0],
        "upload_id"   => parsed_response_body["UploadId"][0],
        "name" => options[:object_name] }
    end

    def sign_batch(options)
      part_numbers = options[:part_numbers].to_s.split("-")

      parts = options[:content_lengths].to_s.split('-').each_with_index.map do |len, i|
        sign_part(options.merge!({content_length: len, part_number: part_numbers[i] }))
      end
    end

    def sign_part(options)
      url = "/#{options[:object_name]}?partNumber=#{options[:part_number]}&uploadId=#{options[:upload_id]}"
      authorization, date = sign_request verb: 'PUT', host: get_host(),
                                          hash: options[:hash],
                                          url: URI.escape(url), content_length: options[:content_length]

      { authorization: authorization, date: date, part_nummber: options[:part_number], host: get_host() }
    end

    def complete(options)
      options[:content_type] = "application/xml"

      url = URI.escape("/#{options[:object_name]}?uploadId=#{options[:upload_id]}")

      body = format_part_list_in_xml(options)
      headers = { content_type: options[:content_type],
                  content_length: options[:content_length] }

      if options[:hash].nil?
        headers['x-amz-content-sha256'] = OpenSSL::Digest::Digest.new("sha256").hexdigest(body)
      else
        headers['x-amz-content-sha256'] = options[:hash]
      end
      headers[:authorization], amzdate = sign_request verb: 'POST',
                                                hash: headers['x-amz-content-sha256'],
                                                host: get_host(),
                                                url: url, content_type: options[:content_type]
      headers['X-Amz-Date'] = amzdate
      response = Http.post url, {headers: headers, body: body}
      parsed_response_body = XmlSimple.xml_in(response.body)

      begin
        return { location: parsed_response_body["Location"][0] }
      rescue NoMethodError
        message = 'Unexpected error'
        message = parsed_response_body["Message"].first
        message =   "Upload does not exist" if parsed_response_body["Message"].first.match("The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.")
        return { error: message }
      end
    end

    def sign_request(options)
      t = Time.now.utc
      amzdate = t.strftime('%Y%m%dT%H%M%SZ')
      datestamp = t.strftime('%Y%m%d')
      [calculate_authorization_hash(datestamp, amzdate, options), amzdate]
    end

    def unique_name(options)
      controller = S3Multipart::Uploader.deserialize(options[:uploader])
      url = [controller.model.to_s.pluralize, UUID.generate, options[:object_name]].join("/")
      if controller.mount_point && defined?(CarrierWaveDirect)
        uploader = controller.model.to_s.classify.constantize.new.send(controller.mount_point)
        if uploader.class.ancestors.include?(CarrierWaveDirect::Uploader)
          url = uploader.key.sub(/#{Regexp.escape(CarrierWaveDirect::Uploader::FILENAME_WILDCARD)}\z/, options[:object_name])
        end
      end
      URI.escape(url)
    end

    private

      def calculate_authorization_hash(datestamp, amzdate, options)
        access_key = Config.instance.s3_access_key
        secret_key = Config.instance.s3_secret_key
        host = options[:host]
        query = URI::decode_www_form(URI.parse(options[:url]).query).to_h
        request_parameters = query.collect do |k,v|
          out = ""
          if v.kind_of?(Hash)
            v.each do |kk,vv|
              out += "#{k}.#{kk}=#{vv}"
            end
          else
            out += "#{k}=#{v}"
          end
          out
        end.join("&")

        signed_headers = 'content-type;host;x-amz-content-sha256;x-amz-date'
        if options[:hash].nil?
          payload_hash = OpenSSL::Digest::Digest.new("sha256").hexdigest("")
        else
          payload_hash = options[:hash]
        end
        canonical_headers = 'content-type:' + [options[:content_type], 'host:' + host,
                      "x-amz-content-sha256:#{payload_hash}", 'x-amz-date:' + amzdate].join("\n") + "\n"

        canonical_request = [options[:verb], URI.parse(options[:url]).path, request_parameters, canonical_headers,
                     signed_headers, payload_hash].join("\n")
        algorithm = 'AWS4-HMAC-SHA256'
        credential_scope = [datestamp, Config.instance.region, 's3', 'aws4_request'].join("/")
        string_to_sign = [
          algorithm, amzdate, credential_scope,
          OpenSSL::Digest::Digest.new("sha256").hexdigest(canonical_request)
        ].join("\n")

        signing_key = getSignatureKey(secret_key, datestamp, Config.instance.region, 's3')
        signature = OpenSSL::HMAC.hexdigest('sha256', signing_key, string_to_sign)

        "#{algorithm} Credential=#{access_key + '/' + credential_scope}, SignedHeaders=#{signed_headers}, Signature=#{signature}"
      end

      def getSignatureKey(key, dateStamp, regionName, serviceName)
        kDate    = OpenSSL::HMAC.digest('sha256', "AWS4" + key, dateStamp)
        kRegion  = OpenSSL::HMAC.digest('sha256', kDate, regionName)
        kService = OpenSSL::HMAC.digest('sha256', kRegion, serviceName)
        kSigning = OpenSSL::HMAC.digest('sha256', kService, "aws4_request")
        kSigning
      end

      def from_upload_part?(options)
        options[:content_length].to_s.match(/^[0-9]+$/) ? true : false
      end

      def format_part_list_in_xml(options)
        hash = Hash["Part", ""];
        hash["Part"] = options[:parts].map do |part|
          { "PartNumber" => part[:partNum], "ETag" => part[:ETag] }
        end
        hash["Part"].sort_by! {|obj| obj["PartNumber"]}

        XmlSimple.xml_out(hash, { :RootName => "CompleteMultipartUpload", :AttrPrefix => true })
      end

      def get_host()
        "#{Config.instance.bucket_name}.s3-#{Config.instance.region}.amazonaws.com"
      end
    end
end
