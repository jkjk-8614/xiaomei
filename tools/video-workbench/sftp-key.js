import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

function runQuietly(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} 退出码 ${code}`)));
  });
}

export async function saveSftpPrivateKey(value, dataDir) {
  const key = String(value || '').trim().replace(/\r\n?/g, '\n') + '\n';
  if (key.length > 64 * 1024) throw new Error('SSH 私钥内容过长');
  const block = /^-----BEGIN ([A-Z ]*PRIVATE KEY)-----\n([A-Za-z0-9+/=\n]+)\n-----END \1-----\n$/.exec(key);
  if (!block || !['OPENSSH PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'PRIVATE KEY'].includes(block[1])) {
    throw new Error('请粘贴完整的 SSH 私钥内容，包含 BEGIN 和 END 行');
  }

  await fs.mkdir(dataDir, { recursive: true });
  const target = path.join(dataDir, 'sftp-private-key');
  const temporary = path.join(dataDir, `.sftp-private-key-${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, key, { mode: 0o600, flag: 'wx' });
    if (process.platform === 'win32') {
      const user = process.env.USERNAME;
      if (!user) throw new Error('无法确定当前 Windows 用户，未保存私钥');
      try { await runQuietly('icacls', [temporary, '/inheritance:r', '/grant:r', `${user}:F`]); }
      catch { throw new Error('无法限制私钥文件权限，未保存私钥'); }
    } else {
      await fs.chmod(temporary, 0o600);
    }
    try { await runQuietly('ssh-keygen', ['-y', '-P', '', '-f', temporary]); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('找不到 ssh-keygen，请安装 OpenSSH 客户端');
      throw new Error('私钥无效或受口令保护，请粘贴可直接用于 SFTP 的完整私钥');
    }
    await fs.rename(temporary, target);
    return target;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
