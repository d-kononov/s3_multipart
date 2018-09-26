module S3Multipart
  class UploadsController < ApplicationController

    def create
      begin
        p 1
        p params.to_h
        p upload_params.to_h
        upload = Upload.create(params.to_h)
        p 2
        upload.execute_callback(:begin, session)
        p 3
        response = upload.to_json
      rescue FileTypeError, FileSizeError => e
        response = {error: e.message}
      rescue => e
        logger.error "EXC: #{e.message}"
        airbrake(e, params)
        response = { error: t("s3_multipart.errors.create") }
      ensure
        render :json => response
      end
    end

    def update
      return complete_upload if params[:parts]
      return sign_batch if params[:content_lengths]
      return sign_part if params[:content_length]
    end

    private

      def upload_params
        params.permit(
          :id, :content_lengths, :content_length, :upload_id,
          :uploader, :content_size, :context,
          :content_type, :object_name, :part_number, :verb, :url,
          headers: {},
          upload: [:uploader, :upload_id],
          parts: [:ETag, :partNum]
        )
      end

      def sign_batch
        begin
          response = Upload.sign_batch(params)
        rescue => e
          logger.error "EXC: #{e.message}"
          airbrake(e, params)
          response = {error: t("s3_multipart.errors.update")}
        ensure
          render :json => response
        end
      end

      def sign_part
        begin
          response = Upload.sign_part(params)
        rescue => e
          logger.error "EXC: #{e.message}"
          airbrake(e, params)
          response = {error: t("s3_multipart.errors.update")}
        ensure
          render :json => response
        end
      end

      def complete_upload
        begin
          response = Upload.complete(params)
          upload = Upload.find_by_upload_id(params[:upload_id])
          if response.present?
            upload.update_attributes(location: response[:location])
          end  
          complete_response = upload.execute_callback(:complete, session)
          response ||= {}
          response[:extra_data] = complete_response if complete_response.is_a?(Hash)
          complete_response
        rescue => e
          logger.error "EXC: #{e.message}"
          airbrake(e, params)
          response = {error: t("s3_multipart.errors.complete"), upload_id: params[:upload_id]}
        ensure
          render :json => response
        end
      end


      def airbrake(e, params)
        Airbrake.notify_or_ignore(
          e,
          :parameters    => params,
          :session      => session
        )
      end
  end
end
