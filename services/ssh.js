const { NodeSSH } = require('node-ssh');

async function deployContainer(host, username, password, imageName, containerName, hostPort, containerPort, sshPrivateKey, sshPassphrase, envVars, useEnvFile, volumes, logCallback) {
  const ssh = new NodeSSH();
  let envFilePath = null;

  try {
    logCallback(`Connecting to ${host}...`);

    // Build connection config - use SSH key if provided, otherwise use password
    const connectionConfig = {
      host: host,
      username: username
    };

    if (sshPrivateKey) {
      connectionConfig.privateKey = sshPrivateKey;
      if (sshPassphrase) {
        connectionConfig.passphrase = sshPassphrase;
        logCallback('Using SSH key authentication with passphrase');
      } else {
        logCallback('Using SSH key authentication');
      }
    } else if (password) {
      connectionConfig.password = password;
      logCallback('Using password authentication');
    } else {
      throw new Error('Either password or SSH private key must be provided');
    }

    await ssh.connect(connectionConfig);

    logCallback('Connected successfully');

    // Pull the new image
    logCallback(`Pulling image ${imageName}...`);
    await executeCommand(ssh, `docker pull ${imageName}`, logCallback);

    // Stop and remove old container if exists
    logCallback(`Stopping old container ${containerName} if exists...`);
    await executeCommand(ssh, `docker stop ${containerName} || true`, logCallback);
    await executeCommand(ssh, `docker rm ${containerName} || true`, logCallback);

    // Build docker run command with optional port mapping and environment variables
    let dockerRunCmd = `docker run -d --name ${containerName}`;

    if (hostPort && containerPort) {
      dockerRunCmd += ` -p ${hostPort}:${containerPort}`;
      logCallback(`Port mapping: ${hostPort} -> ${containerPort}`);
    }

    // Add environment variables if provided
    if (envVars && envVars.trim()) {
      const envLines = envVars.split('\n').filter(line => line.trim());

      if (useEnvFile) {
        // Use env file mode - write env vars to temp file and use --env-file
        envFilePath = `/tmp/.env-${containerName}-${Date.now()}`;
        logCallback(`Using env file mode: ${envFilePath}`);

        // Write env file content using base64 to avoid shell escaping issues
        const envContent = envLines.map(line => line.trim()).join('\n');
        const base64Content = Buffer.from(envContent).toString('base64');
        await executeCommand(ssh, `echo "${base64Content}" | base64 -d > ${envFilePath}`, logCallback, true);

        dockerRunCmd += ` --env-file ${envFilePath}`;
        logCallback(`Environment variables: ${envLines.length} variable(s) set via env file`);
      } else {
        // Use inline mode - add each env var as -e flag
        envLines.forEach(line => {
          const trimmedLine = line.trim();
          if (trimmedLine) {
            dockerRunCmd += ` -e "${trimmedLine}"`;
          }
        });
        logCallback(`Environment variables: ${envLines.length} variable(s) set inline`);
      }
    }

    // Add volumes if provided
    if (volumes && volumes.trim()) {
      const volumeLines = volumes.split('\n').filter(line => line.trim());
      volumeLines.forEach(line => {
        const trimmedLine = line.trim();
        if (trimmedLine) {
          dockerRunCmd += ` -v ${trimmedLine}`;
        }
      });
      logCallback(`Volumes: ${volumeLines.length} volume(s) mounted`);
    }

    dockerRunCmd += ` ${imageName}`;

    // Run new container
    logCallback(`Starting new container ${containerName}...`);
    await executeCommand(ssh, dockerRunCmd, logCallback);

    logCallback('Container deployed successfully');

    // Clean up env file if it was created
    if (envFilePath) {
      logCallback('Cleaning up env file...');
      await executeCommand(ssh, `rm -f ${envFilePath}`, logCallback, true);
    }

    ssh.dispose();
  } catch (error) {
    // Clean up env file on error
    if (envFilePath) {
      try {
        await executeCommand(ssh, `rm -f ${envFilePath}`, () => {}, true);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    }
    ssh.dispose();
    throw error;
  }
}

async function executeCommand(ssh, command, logCallback, silent = false) {
  const result = await ssh.execCommand(command);

  if (!silent) {
    if (result.stdout) {
      logCallback(result.stdout);
    }

    if (result.stderr) {
      logCallback(result.stderr);
    }
  }

  if (result.code !== 0) {
    throw new Error(`Command failed with exit code ${result.code}: ${command}`);
  }

  return result;
}

module.exports = {
  deployContainer
};
