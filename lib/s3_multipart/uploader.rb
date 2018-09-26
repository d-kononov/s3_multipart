require "s3_multipart/uploader/callbacks"
require "s3_multipart/uploader/validations"
require 'active_support/core_ext/string'
require "digest/sha1"

module S3Multipart
  module Uploader

    class << self
      attr_accessor :controllers
    end

    self.controllers = {}

    def self.serialize(controller)
      p 'serialize'
      p controller.to_s.to_sym
      p controllers
      controllers[controller.to_s.to_sym]
    end

    def self.deserialize(digest)
      p 1234
      p digest
      p controllers.key(digest).to_s
      p 12345
      p controllers.key(digest).to_s.constantize
      p 123456
      controllers.key(digest).to_s.constantize
    end

    # Generated multipart upload controllers (which reside in the app/uploaders/multipart
    # directory in the Rails application) extend this module.
    module Core

      include S3Multipart::Uploader::Callbacks
      include S3Multipart::Uploader::Validations

      attr_accessor :mount_point, :model

      def self.extended(klass)
        p 'EXTENDED'
        p klass
        Uploader.controllers[klass.to_s.to_sym] = Digest::SHA1.hexdigest(klass.to_s)
      end

      def attach(model, options = {})
        self.mount_point = options.delete(:using)
        self.model = model

        S3Multipart::Upload.class_eval do
          has_one(model, options)
        end
      end

    end

  end 
end
