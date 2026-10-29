const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const sshService = require('./ssh');

// Converts a glob-style pattern (supporting * and ?, scoped to a single path
// segment like shell globs) into matchers for both an exact path match and a
// "anything nested under this" match.
function compilePattern(pattern) {
  const regexSource = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');

  return {
    hasSlash: pattern.includes('/'),
    exact: new RegExp(`^${regexSource}$`),
    nested: new RegExp(`^${regexSource}/`)
  };
}

function parsePatterns(patterns) {
  if (!patterns) return [];
  return patterns
    .split('\n')
    .map(line => line.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter(Boolean)
    .map(compilePattern);
}

function shouldIgnore(relPath, compiledPatterns) {
  const segments = relPath.split('/');
  return compiledPatterns.some(({ hasSlash, exact, nested }) => {
    if (hasSlash) {
      return exact.test(relPath) || nested.test(relPath);
    }
    return segments.some(seg => exact.test(seg));
  });
}

function hashFile(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function buildLocalManifest(projectPath, ignorePatterns) {
  const patterns = [compilePattern('.git'), ...parsePatterns(ignorePatterns)];
  const manifest = new Map();

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relPath = path.relative(projectPath, absPath).split(path.sep).join('/');

      if (shouldIgnore(relPath, patterns)) continue;

      if (entry.isDirectory()) {
        await walk(absPath);
      } else if (entry.isFile()) {
        manifest.set(relPath, await hashFile(absPath));
      }
    }
  }

  await walk(projectPath);
  return manifest;
}

async function getRemoteManifest(ssh, remotePath, logCallback) {
  const result = await ssh.execCommand(`find "${remotePath}" -type f -exec sha256sum {} \\;`);

  if (result.stderr) {
    logCallback(result.stderr);
  }

  const manifest = new Map();
  const lines = result.stdout.split('\n').filter(line => line.trim());

  for (const line of lines) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line);
    if (!match) continue;

    const [, hash, absRemotePath] = match;
    const relPath = path.posix.relative(remotePath, absRemotePath);
    manifest.set(relPath, hash);
  }

  return manifest;
}

function diffManifests(localManifest, remoteManifest) {
  const toUpload = [];
  for (const [relPath, hash] of localManifest) {
    if (remoteManifest.get(relPath) !== hash) {
      toUpload.push(relPath);
    }
  }
  return toUpload;
}

async function syncFiles(ssh, projectPath, remotePath, filesToUpload, logCallback) {
  for (const relPath of filesToUpload) {
    const localAbsPath = path.join(projectPath, relPath);
    const remoteAbsPath = path.posix.join(remotePath, relPath);
    await ssh.putFile(localAbsPath, remoteAbsPath);
    logCallback(`Uploaded: ${relPath}`);
  }
}

async function writeEnvFile(ssh, remotePath, envFileContent, logCallback) {
  logCallback('Writing .env file...');
  const base64Content = Buffer.from(envFileContent).toString('base64');
  const remoteEnvPath = path.posix.join(remotePath, '.env');
  await sshService.executeCommand(ssh, `echo "${base64Content}" | base64 -d > "${remoteEnvPath}"`, logCallback, true);
  logCallback('.env file written');
}

async function runPostDeployCommands(ssh, remotePath, postDeployCommands, logCallback) {
  const commands = postDeployCommands.split('\n').map(line => line.trim()).filter(Boolean);

  for (const command of commands) {
    logCallback(`Running: ${command}`);
    await sshService.executeCommand(ssh, `cd "${remotePath}" && ${command}`, logCallback);
  }
}

async function deployPhp(config, logCallback) {
  const { projectPath, remotePath, ignorePatterns, envFileContent, postDeployCommands, sshHost, sshUser, sshPassword, sshPrivateKey, sshPassphrase } = config;

  let ssh;
  try {
    ssh = await sshService.connect(sshHost, sshUser, sshPassword, sshPrivateKey, sshPassphrase, logCallback);

    logCallback('Scanning local project files...');
    const localManifest = await buildLocalManifest(projectPath, ignorePatterns);
    logCallback(`Found ${localManifest.size} local file(s) to consider`);

    logCallback('Fetching remote file checksums...');
    const remoteManifest = await getRemoteManifest(ssh, remotePath, logCallback);
    logCallback(`Found ${remoteManifest.size} file(s) already on server`);

    const filesToUpload = diffManifests(localManifest, remoteManifest);
    logCallback(`${filesToUpload.length} file(s) need to be uploaded`);

    await syncFiles(ssh, projectPath, remotePath, filesToUpload, logCallback);

    if (envFileContent && envFileContent.trim()) {
      await writeEnvFile(ssh, remotePath, envFileContent, logCallback);
    }

    if (postDeployCommands && postDeployCommands.trim()) {
      await runPostDeployCommands(ssh, remotePath, postDeployCommands, logCallback);
    }

    ssh.dispose();
  } catch (error) {
    if (ssh) ssh.dispose();
    throw error;
  }
}

module.exports = {
  deployPhp
};
