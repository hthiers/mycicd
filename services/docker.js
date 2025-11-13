const Docker = require('dockerode');
const tar = require('tar-fs');
const path = require('path');

const docker = new Docker();

async function buildImage(projectPath, imageName, buildPlatform, logCallback) {
  return new Promise((resolve, reject) => {
    const tarStream = tar.pack(projectPath);

    // Build options with image name
    const buildOptions = { t: imageName };

    // Add platform if specified
    if (buildPlatform) {
      buildOptions.platform = buildPlatform;
      logCallback(`Building for platform: ${buildPlatform}`);
    }

    docker.buildImage(tarStream, buildOptions, (err, stream) => {
      if (err) {
        return reject(err);
      }

      docker.modem.followProgress(stream, onFinished, onProgress);

      function onFinished(err, output) {
        if (err) {
          return reject(err);
        }
        resolve();
      }

      function onProgress(event) {
        if (event.stream) {
          logCallback(event.stream.trim());
        } else if (event.status) {
          logCallback(event.status);
        }
      }
    });
  });
}

async function pushImage(imageName, username, password, logCallback) {
  return new Promise(async (resolve, reject) => {
    try {
      const image = docker.getImage(imageName);

      const auth = {
        username: username,
        password: password
      };

      const stream = await image.push({ authconfig: auth });

      docker.modem.followProgress(stream, onFinished, onProgress);

      function onFinished(err, output) {
        if (err) {
          return reject(err);
        }
        resolve();
      }

      function onProgress(event) {
        if (event.status) {
          const msg = event.progress ? `${event.status} ${event.progress}` : event.status;
          logCallback(msg);
        }
      }
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = {
  buildImage,
  pushImage
};
