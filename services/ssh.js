const { NodeSSH } = require('node-ssh');

async function deployContainer(host, username, password, imageName, containerName, hostPort, containerPort, sshPrivateKey, sshPassphrase, envVars, volumes, logCallback) {
  const ssh = new NodeSSH();

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
      envLines.forEach(line => {
        const trimmedLine = line.trim();
        if (trimmedLine) {
          dockerRunCmd += ` -e "${trimmedLine}"`;
        }
      });
      logCallback(`Environment variables: ${envLines.length} variable(s) set`);
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

    ssh.dispose();
  } catch (error) {
    ssh.dispose();
    throw error;
  }
}

async function executeCommand(ssh, command, logCallback) {
  const result = await ssh.execCommand(command);

  if (result.stdout) {
    logCallback(result.stdout);
  }

  if (result.stderr) {
    logCallback(result.stderr);
  }

  if (result.code !== 0) {
    throw new Error(`Command failed with exit code ${result.code}: ${command}`);
  }

  return result;
}

module.exports = {
  deployContainer
};
