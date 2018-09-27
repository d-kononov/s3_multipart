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

    // Wrap this into underscore library extension
    _.mixin({
      findIndex : function (collection, filter) {
        for (var i = 0; i < collection.length; i++) {
          if (filter(collection[i], i, collection)) {
            return i;
          }
        }
        return -1;
      }
    });