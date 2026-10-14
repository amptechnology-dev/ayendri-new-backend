const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
require("dotenv").config();

const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const uploadToR2 = async (fileBuffer, fileName, mimeType) => {
  const params = {
    Bucket: process.env.R2_BUCKET_NAME,
    Key: fileName,
    Body: fileBuffer,
    ContentType: mimeType,
    CacheControl: "public, max-age=31536000, immutable",
  };

  await r2.send(new PutObjectCommand(params));

  return `${process.env.R2_PUBLIC_URL}/${fileName}`;
};

const deleteFromR2 = async (fileName) => {
  const params = {
    Bucket: process.env.R2_BUCKET_NAME,
    Key: fileName,
  };

  await r2.send(new DeleteObjectCommand(params));
  return true;
};

module.exports = {
  uploadToR2,
  deleteFromR2,
};