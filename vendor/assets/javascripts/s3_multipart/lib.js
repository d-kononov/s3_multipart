function calc_hash(blob, cb) {
  var file_size = blob.size;
    var chunk_size = 1 * 1024 * 1024;
    var offset = 0;
    var time_started = Date.now();
    var hasher = new asmCrypto.SHA256();
    var file_reader = new FileReader();

    file_reader.onload = function(e) {
      if (e.target.error === null) {
          offset += e.loaded;
          hasher.process(e.target.result);
      } else {
          console.log('err');
          return;
      }
      var time_elapsed_seconds = Math.floor((Date.now() - time_started) / 100) / 10;
      if (offset < file_size) {
          file_reader.readAsArrayBuffer(blob.slice(offset, chunk_size + offset));
      } else {
          hasher.finish();
          console.log("DONE");
          console.log(asmCrypto.bytes_to_hex(hasher.result));
          //on_hash_done(asmCrypto.bytes_to_hex(hasher.result), time_elapsed_seconds);
          cb(asmCrypto.bytes_to_hex(hasher.result));
      }
    }
    file_reader.readAsArrayBuffer(blob.slice(offset, chunk_size + offset));
};

(function(global) {
  global.S3MP = (function() {

// S3MP Constructor
function S3MP(options) {
  var files
    , progress_timer = []
    , S3MP = this;

  _.extend(this, options);
  this.headers = _.fromPairs(_.map(options.headers, function(v,k) { return ["x-amz-" + k.toLowerCase(), v] }));

  this.uploadList = [];

  // Handles all of the success/failure events, and
  // progress notifiers
  this.handler = {

    // Activate an appropriate number of parts (number = pipes)
    // when all of the parts have been successfully initialized
    beginUpload: function() {
      var i = [];
      function beginUpload(pipes, uploadObj) {
        var key = uploadObj.key
          , num_parts = uploadObj.parts.length;

        if (typeof i[key] === "undefined") {
          i[key] = 0;
        }

        i[key]++;

        for (var j=0; j<pipes; j++) {
          uploadObj.parts[j].activate();
        }
        S3MP.handler.startProgressTimer(key);
        S3MP.onStart(uploadObj); // This probably needs to go somewhere else.
      }
      return beginUpload;
    }(),

    // called when an upload is paused or the network connection cuts out
    onError: function(uploadObj, part) {
      S3MP.onError(uploadObj, part);
    },

    // called when a single part has successfully uploaded
    onPartSuccess: function(uploadObj, finished_part) {
      var parts, i, ETag;

      parts = uploadObj.parts;
      finished_part.status = "complete";

      // Append the ETag (in the response header) to the ETags array
      ETag = finished_part.xhr.getResponseHeader("ETag");
      uploadObj.Etags.push({ ETag: ETag.replace(/\"/g, ''), partNum: finished_part.num });

      // Increase the uploaded count and delete the finished part
      uploadObj.uploaded += finished_part.size;
      uploadObj.inprogress[finished_part.num] = 0;
      i = _.indexOf(parts, finished_part);
      parts.splice(i,1);

      // activate one of the remaining parts
      if (parts.length) {
        i = _.findIndex(parts, function(el, index, collection) {
          if (el.status !== "active") {
            return true;
          }
        });
        if (i !== -1){
          parts[i].activate();
        }
      }

      // If no parts remain then the upload has finished
      if (!parts.length) {
        this.onComplete(uploadObj);
      }
    },

    // called when all parts have successfully uploaded
    onComplete: function(uploadObj) {
      var key = _.indexOf(S3MP.uploadList, uploadObj);

      // Stop the onprogress timer
      this.clearProgressTimer(key);

      // Tell the server to put together the pieces
      S3MP.completeMultipart(uploadObj, function(obj) {
        // Notify the client that the upload has succeeded when we
        // get confirmation from the server
        if (obj.location) {
          obj.extra_data ? S3MP.onComplete(uploadObj, obj.extra_data) : S3MP.onComplete(uploadObj);
        }
      });

    },

    // Called by progress_timer
    onProgress: function(key, size, done, percent, speed) {
      S3MP.onProgress(key, size, done, percent, speed);
    },

    startProgressTimer: function() {
      var last_upload_chunk = [];
      var fn = function(key) {
        progress_timer[key] = global.setInterval(function() {
          var upload, size, done, percent, speed;

          if (typeof last_upload_chunk[key] === "undefined") {
            last_upload_chunk[key] = 0;
          }

          upload = S3MP.uploadList[key];
          size = upload.size;
          done = upload.uploaded;

          _.each(upload.inprogress,function(val, index) {
            part_available = _.find(upload.parts, function(part){
              return part.num == index
            })
            if(part_available && val !== undefined) done += val;
          });

          percent = done/size * 100;
          speed = done - last_upload_chunk[key];
          last_upload_chunk[key] = done;

          upload.handler.onProgress(key, size, done, percent, speed);
        }, 1000);
      };
      return fn;
    }(),

    clearProgressTimer: function(key) {
      global.clearInterval(progress_timer[key]);
    }

  };

  // List of files may come from a FileList object or an array of files
  if (this.fileSelector) {
    files = $(this.fileSelector).get(0).files; // FileList object
  } else {
    files = this.fileList; // array specified in configuration
  }

  _.each(files, function(file, key) {
    var upload = new Upload(file, S3MP, key);
    S3MP.uploadList.push(upload);
    upload.init();
  });

};

S3MP.prototype.initiateMultipart = function(upload, cb) {
  var url, body, xhr;

  url = '/s3_multipart/uploads';
  body = JSON.stringify({ object_name  : upload.name,
                          content_type : upload.type,
                          content_size : upload.size,
                          context_data : upload.context_data,
                          hash         : upload.parts[0].hash,
                          headers      : this.headers,
                          context      : $(this.fileInputElement).data("context"),
                          base_path    : $(this.fileInputElement).data("base-path"),
                          uploader     : $(this.fileInputElement).data("uploader")
                        });

  xhr = this.createXhrRequest('POST', url);
  this.deliverRequest(xhr, body, cb);

};

S3MP.prototype.signPartRequest = function(id, object_name, upload_id, part, hash, cb) {
  var content_lengths, url, body, xhr;

  content_length = part.size;
  url = "/s3_multipart/uploads/"+id;
  body = JSON.stringify({ object_name     : object_name,
    upload_id       : upload_id,
    content_length : content_length,
    hash: hash,
    part_number : part.num
  });
  xhr = this.createXhrRequest('PUT', url);
  this.deliverRequest(xhr, body, cb);
};

S3MP.prototype.completeMultipart = function(uploadObj, cb) {
  var url, body, xhr;
  var attempts_remaining = 4;

  while(true) {
    try {
      url = '/s3_multipart/uploads/'+uploadObj.id;
      body = JSON.stringify({ object_name    : uploadObj.object_name,
                              upload_id      : uploadObj.upload_id,
                              content_length : uploadObj.size,
                              parts          : uploadObj.Etags
                            });

      xhr = this.createXhrRequest('PUT', url);
      this.deliverRequest(xhr, body, cb);
      return;
    } catch (e) {
      // handle exception
      console.log('Exception while completing: ', e);
      if (--attempts_remaining < 1) throw e;
    }
  }
};

// Specify callbacks, request body, and settings for requests that contact
// the site server, and send the request.
S3MP.prototype.deliverRequest = function(xhr, body, cb, part) {
  var self = this;

  xhr.onload = function() {
    response = JSON.parse(this.responseText);
    if (response.error) {
      if (self.onResponseError) {
        var uploadObj = _.find(self.uploadList, { 'upload_id': response.upload_id })
        self.onResponseError(uploadObj)
      }
      return self.onError({
        name: "ServerResponse",
        message: response.error
      });
    }
    cb(response, part);
  };

  xhr.onerror = function() {
    console.log("onerror invoke for xhr request under part " + part[0].num + " re activating it.");
    part[0].activate();
  };

  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('X-CSRF-Token', $('meta[name="csrf-token"]').attr('content'));

  xhr.send(body);
}

S3MP.prototype.createXhrRequest = function() {
  var xhrRequest;

  // Sniff for xhr object
  if (typeof XMLHttpRequest.constructor === "function") {
    xhrRequest = XMLHttpRequest;
  } else if (typeof XDomainRequest !== "undefined") {
    xhrRequest = XDomainRequest;
  } else {
    xhrRequest = null; // Error out to the client (To-do)
  }

  return function(method, url, cb, open) { // open defaults to true
    var args, xhr, open = true;

    args = Array.prototype.slice.call(arguments);
    if (typeof args[0] === "undefined") {
      cb = null;
      open = false;
    }

    xhr = new xhrRequest();
    if (open) { // open the request unless specified otherwise
      xhr.open(method, url, true);
    }
    xhr.onreadystatechange = cb;

    return xhr;
  };

}();

S3MP.prototype.sliceBlob = function() {
  try {
    var test_blob = new Blob();
  } catch(e) {
    return "Unsupported";
  }

  if (test_blob.slice) {
    return function(blob, start, end) {
      return blob.slice(start, end);
    }
  } else if (test_blob.mozSlice) {
    return function(blob, start, end) {
      return blob.mozSlice(start, end);
    }
  } else if (test_blob.webkitSlice) {
    return function(blob, start, end) {
      return blob.webkitSlice(start, end);
    }
  } else {
    return "Unsupported";
  }
}();

// utility function to return an upload object given a file
S3MP.prototype._returnUploadObj = function(key) {
  var uploadObj = _.find(this.uploadList, function(uploadObj) {
    return uploadObj.key === key;
  });
  return uploadObj;
};

// cancel a given file upload
S3MP.prototype.cancel = function(key) {
  var uploadObj, i;

  uploadObj = this._returnUploadObj(key);
  i = _.indexOf(this.uploadList, uploadObj);

  this.uploadList.splice(i,i+1);
  this.onCancel(key);
  this.handler.clearProgressTimer(key);
};

// pause a given file upload
S3MP.prototype.pause = function(key) {
  var uploadObj = this._returnUploadObj(key);

  _.each(uploadObj.parts, function(part, key, list) {
    if (part.status == "active") {
      part.pause();
    }
  });

  this.onPause(key);
  this.handler.clearProgressTimer(key);
};

// resume a given file upload
S3MP.prototype.resume = function(key) {
  var uploadObj = this._returnUploadObj(key);

  _.each(uploadObj.parts, function(part, key, list) {
    if (part.status == "paused") {
      part.activate();
    }
  });
  this.handler.startProgressTimer(key);
  this.onResume(key);
};

// Upload constructor
function Upload(file, o, key) {
  function Upload() {
    var upload, id, parts, part, segs, chunk_segs, chunk_lens, pipes, blob;

    upload = this;

    var upload, id, parts, part, segs, chunk_segs, chunk_lens, pipes, blob, chunkSize;
    
    upload = this;
    chunkSize = 5242880;
    
    this.key = key;
    this.file = file;
    this.name = file.name;
    this.size = file.size;
    this.type = file.type;
    this.Etags = [];
    this.inprogress = [];
    this.uploaded = 0;
    this.status = "";

    // Break the file into an appropriate amount of chunks
    // This needs to be optimized for various browsers types/versions
    if (this.size > 800 * chunkSize) { // size greater than 4gb
      console.info('size greater than 4gb')
      num_segs = 800;
      pipes = 20;
    } else if (this.size > 400 * chunkSize) { // size greater than 2gb
      console.info('size greater than 2gb')
      num_segs = 400;
      pipes = 15;
    } else if (this.size > 200 * chunkSize) { // size greater than 1gb
      console.info('size greater than 1gb')
      num_segs = 200;
      pipes = 20;
    } else if (this.size > 100 * chunkSize) { // greater than 500mb
      num_segs = 100;
      pipes = 7;
      console.info('size greater than 500mb')
    } else if (this.size > 20 * chunkSize) { // greater than 100 mb
      num_segs = 20;
      pipes = 5;
    } else if (this.size > 10 * chunkSize) { // greater than 50 mb
      num_segs = 10;
      pipes = 2;
    } else if (this.size > 2 * chunkSize) { // greater than 10 mb
      num_segs = 2;
      pipes = 1;
    } else { // greater than 5 mb (S3 does not allow multipart uploads < 5 mb)
      num_segs = 1;
      pipes = 1;
    }

    chunk_segs = _.range(num_segs + 1);
    chunk_lens = _.map(chunk_segs, function(seg) {
      return Math.round(seg * (file.size/num_segs));
    });

    if (upload.sliceBlob == "Unsupported") {
      this.parts = [new UploadPart(file, 0, upload)];
    } else {
      this.parts = _.map(chunk_lens, function(len, i) {
        blob = upload.sliceBlob(file, len, chunk_lens[i+1]);
        return new UploadPart(blob, i+1, upload);
      });
      this.parts.pop(); // Remove the empty blob at the end of the array
    }

    // init function will initiate the multipart upload, sign all the parts, and
    // start uploading some parts in parallel
    this.init = function() {
      calc_hash(upload.parts[0].blob, function(hash){
        upload.parts[0].hash = hash;
        upload.initiateMultipart(upload, function(obj) {
          var id = upload.id = obj.id
            , upload_id = upload.upload_id = obj.upload_id
            , object_name = upload.object_name = obj.key // uuid generated by the server, different from name
            , parts = upload.parts;
  
          //upload.signPartRequests(id, object_name, upload_id, parts, function(response) {
          //  _.each(parts, function(part, key) {
          //    part.date = response.uploads[key].date;
          //    part.auth = response.uploads[key].authorization;
          //
          //    // Notify handler that an xhr request has been opened
          //    upload.handler.beginUpload(pipes, upload);
          //  });
          //});
          upload.handler.beginUpload(pipes, upload);
        }); 
      });
    } 
  };
  // Inherit the properties and prototype methods of the passed in S3MP instance object
  Upload.prototype = o;
  return new Upload();
}

// Upload part constructor
function UploadPart(blob, key, upload) {
  var part, xhr;

  part = this;

  this.size = blob.size;
  this.blob = blob;
  this.num = key;
  this.upload = upload;

  this.xhr = xhr = upload.createXhrRequest();
  xhr.onload = function() {
    if (part.xhr.getResponseHeader("ETag") === null) {
      console.log('error response Etag null',response);
      console.log('onError part Etag null',part);
      upload.handler.onError(upload, part);
    } else {
      upload.handler.onPartSuccess(upload, part);
    }
  };
  xhr.onerror = function(response) {
    console.log('error response',response);
    console.log('onError part',part);
    upload.handler.onError(upload, part);
  };
  xhr.upload.onprogress = _.throttle(function(e) {
    if (e.lengthComputable) {
      upload.inprogress[key] = e.loaded;
    }
  }, 1000);

};

UploadPart.prototype.activate = function() {
  var upload_part = this;
  calc_hash(upload_part.blob, function(hash){
    upload_part.upload.signPartRequest(upload_part.upload.id, upload_part.upload.object_name, upload_part.upload.upload_id, upload_part, hash, function(response) {
      upload_part.xhr.open('PUT', '//bucket-for-income-video-files.s3-eu-west-2.amazonaws.com/'+upload_part.upload.object_name+'?partNumber='+upload_part.num+'&uploadId='+upload_part.upload.upload_id, true);
      upload_part.xhr.setRequestHeader('x-amz-date', response.date);
      upload_part.xhr.setRequestHeader('X-Amz-Content-Sha256', hash);
      upload_part.xhr.setRequestHeader('Authorization', response.authorization);

      upload_part.xhr.send(upload_part.blob);
      upload_part.status = "active";
    });
  });
};

UploadPart.prototype.pause = function() {
  this.xhr.abort();
  this.status = "paused";
};

return S3MP;

  }());

}(this));
