const Docker = require('dockerode');
const tar = require('tar-fs');
const path = require('path');

const docker = new Docker();

async function buildImage(projectPath, imageName, buildPlatform, dockerfileName, contextPath, logCallback) {
  return new Promise((resolve, reject) => {
    // Use contextPath (defaults to '.') to determine the build context
    const effectiveContextPath = contextPath && contextPath.trim() !== '' ? contextPath : '.';
    const buildContextPath = path.join(projectPath, effectiveContextPath);

    logCallback(`Build context path: ${buildContextPath}`);
    const tarStream = tar.pack(buildContextPath);

    // Build options with image name
    const buildOptions = { t: imageName };

    // Add platform if specified
    if (buildPlatform) {
      buildOptions.platform = buildPlatform;
      logCallback(`Building for platform: ${buildPlatform}`);
    }

    // Add custom dockerfile if specified
    // Dockerfile path is relative to projectPath, but Docker API expects it relative to build context
    if (dockerfileName && dockerfileName.trim() !== '') {
      // Calculate absolute path of Dockerfile
      const absoluteDockerfilePath = path.join(projectPath, dockerfileName);

      // Calculate relative path from build context to Dockerfile
      const relativeDockerfilePath = path.relative(buildContextPath, absoluteDockerfilePath);

      buildOptions.dockerfile = relativeDockerfilePath;
      logCallback(`Using Dockerfile: ${dockerfileName} (resolved to: ${relativeDockerfilePath} relative to context)`);
    }

    docker.buildImage(tarStream, buildOptions, (err, stream) => {
      if (err) {
        return reject(err);
      }

      docker.modem.followProgress(stream, onFinished, onProgress);

      async function onFinished(err, output) {
        if (err) {
          return reject(err);
        }

        // Verify the image was created and tagged
        try {
          const image = docker.getImage(imageName);
          await image.inspect();
          logCallback(`Verified image exists: ${imageName}`);
          resolve();
        } catch (inspectErr) {
          // Image doesn't exist with the tag, try to find the built image ID and tag it
          logCallback(`Image tag verification failed, attempting to tag from build output...`);

          // Look for the image ID in the build output
          let imageId = null;
          if (output && Array.isArray(output)) {
            for (const event of output) {
              if (event.aux && event.aux.ID) {
                imageId = event.aux.ID;
                break;
              }
            }
          }

          if (imageId) {
            try {
              logCallback(`Found built image ID: ${imageId}, tagging as ${imageName}`);
              const builtImage = docker.getImage(imageId);
              await builtImage.tag({ repo: imageName.split(':')[0], tag: imageName.split(':')[1] || 'latest' });
              logCallback(`Successfully tagged image: ${imageName}`);
              resolve();
            } catch (tagErr) {
              reject(new Error(`Failed to tag image: ${tagErr.message}`));
            }
          } else {
            reject(new Error(`Image was built but could not be found or tagged: ${inspectErr.message}`));
          }
        }
      }

      function onProgress(event) {
        // Check for errors in the progress stream
        if (event.error || event.errorDetail) {
          const errorMsg = event.error || event.errorDetail.message || 'Unknown build error';
          return reject(new Error(errorMsg));
        }

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
        // Check for errors in the progress stream
        if (event.error || event.errorDetail) {
          const errorMsg = event.error || event.errorDetail.message || 'Unknown push error';
          return reject(new Error(errorMsg));
        }

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
