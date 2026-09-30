const { app, BrowserWindow, dialog, shell, Tray, Menu, nativeImage, ipcMain, Notification } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const { appendFileSync, cpSync, createWriteStream, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { decodeInstallerPath, pathEncodingIsCorrupted } = require('./path-encoding.cjs')

const DEVELOPMENT_API_PORT = 5175
const DEFAULT_PACKAGED_API_PORT = 5275
const DEV_URL = 'http://127.0.0.1:5180'
const SOFTWARE_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
const SOFTWARE_UPDATE_RETRY_MS = 60 * 60 * 1000
const FILESYSTEM_APP_NAME = 'DX OS'
const CONFIG_DIRECTORY_NAMES = ['DX OS', 'DX-OS', 'DXOS']
const isDevelopment = !app.isPackaged
const portableRootArgument = String(process.env.DX_PORTABLE_ROOT || '').trim()
const portableRoot = app.isPackaged
  ? path.resolve(portableRootArgument && path.isAbsolute(portableRootArgument) ? portableRootArgument : path.dirname(process.execPath))
  : ''
const portableMode = !!portableRoot && existsSync(path.join(portableRoot, 'dx-os-portable.json'))
const portableDataDirectory = portableMode ? path.join(portableRoot, 'data') : ''
const portableRuntimeArgument = String(process.env.DX_PORTABLE_RUNTIME_DIR || '').trim()
const portableVersionsRoot = portableMode ? path.join(portableRoot, '.dx-runtime', 'versions') : ''
const portableRuntimeDirectory = portableMode && portableRuntimeArgument && path.isAbsolute(portableRuntimeArgument)
  && path.resolve(portableRuntimeArgument).toLowerCase().startsWith(`${path.resolve(portableVersionsRoot).toLowerCase()}${path.sep}`)
  ? path.resolve(portableRuntimeArgument)
  : ''
const portableLauncherPath = portableMode && process.env.DX_PORTABLE_LAUNCHER && path.isAbsolute(process.env.DX_PORTABLE_LAUNCHER)
  ? path.resolve(process.env.DX_PORTABLE_LAUNCHER)
  : process.execPath
const traySmokeTest = process.argv.includes('--tray-smoke-test')
const smokeTest = process.argv.includes('--smoke-test') || traySmokeTest
const portableUpdateSmokeTest = process.argv.includes('--portable-update-smoke-test')
const portableUpdateVerify = process.argv.includes('--portable-update-verify')

if (portableMode) {
  const electronDataDirectory = path.join(portableDataDirectory, 'runtime')
  const electronCacheDirectory = path.join(portableDataDirectory, 'cache', 'electron')
  const portableLogsDirectory = path.join(portableDataDirectory, 'logs')
  const crashDumpsDirectory = path.join(portableDataDirectory, 'crash-dumps')
  for (const directory of [electronDataDirectory, electronCacheDirectory, portableLogsDirectory, crashDumpsDirectory]) {
    mkdirSync(directory, { recursive: true })
  }
  app.setPath('userData', electronDataDirectory)
  app.setPath('sessionData', electronDataDirectory)
  app.setPath('cache', electronCacheDirectory)
  app.setPath('logs', portableLogsDirectory)
  app.setPath('crashDumps', crashDumpsDirectory)
  app.commandLine.appendSwitch('disk-cache-dir', electronCacheDirectory)
}

let apiPort = isDevelopment ? DEVELOPMENT_API_PORT : DEFAULT_PACKAGED_API_PORT
let apiUrl = `http://127.0.0.1:${apiPort}`
let desktopConfigPath = ''
let lanEnabled = false
let dataDirectory = ''

let mainWindow = null
let tray = null
let apiProcess = null
let workerProcess = null
let packagedServiceContext = null
let quitting = false
let logDirectory = ''
let desktopRunId = ''
let desktopConfigSnapshot = ''
let softwareUpdateTimer = null
let mandatoryUpdateActive = false

app.setName('DX OS')

function writeLog(message) {
  const line = `${new Date().toISOString()} ${message}\n`
  process.stdout.write(line)
  if (!logDirectory) return
  try { appendFileSync(path.join(logDirectory, 'desktop.log'), line, 'utf8') } catch { /* console remains available */ }
}

function validPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null
}

function platformAppDataRoot() {
  if (process.platform === 'darwin') return app.getPath('appData')
  return process.env.LOCALAPPDATA || app.getPath('userData')
}

function readDesktopConfig() {
  if (!desktopConfigPath || !existsSync(desktopConfigPath)) return {}
  try { return JSON.parse(readFileSync(desktopConfigPath, 'utf8')) } catch { return {} }
}

function writeDesktopConfig(patch) {
  const config = { ...readDesktopConfig(), ...patch }
  mkdirSync(path.dirname(desktopConfigPath), { recursive: true })
  writeFileSync(desktopConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return config
}

function loadPackagedConfig() {
  if (isDevelopment) return
  if (portableMode) {
    const configDirectory = path.join(portableDataDirectory, 'config')
    desktopConfigPath = path.join(configDirectory, 'desktop.json')
    mkdirSync(configDirectory, { recursive: true })
    const config = readDesktopConfig()
    const configuredPort = validPort(config.port)
    lanEnabled = config.lanEnabled === true
    const argument = process.argv.find((value) => value.startsWith('--api-port='))?.split('=')[1]
    apiPort = validPort(argument) || validPort(process.env.DX_DESKTOP_API_PORT) || configuredPort || DEFAULT_PACKAGED_API_PORT
    apiUrl = `http://127.0.0.1:${apiPort}`
    writeDesktopConfig({ port: apiPort, lanEnabled, dataDirectory: portableDataDirectory, pendingDataMigrationFrom: null })
    desktopConfigSnapshot = JSON.stringify({ port: apiPort, lanEnabled, dataDirectory: portableDataDirectory })
    return
  }
  const localRoot = platformAppDataRoot()
  // 配置目录是安装位置和数据位置的索引，更新时必须继续使用已经存在的
  // 旧配置，不能仅因推荐目录名称变化就复制并切换到另一个目录。
  const existingConfig = CONFIG_DIRECTORY_NAMES
    .map((name) => path.join(localRoot, name, 'config', 'desktop.json'))
    .find(existsSync)
  const configDirectory = existingConfig
    ? path.dirname(existingConfig)
    : path.join(localRoot, 'DX OS', 'config')
  desktopConfigPath = path.join(configDirectory, 'desktop.json')
  mkdirSync(configDirectory, { recursive: true })
  const config = readDesktopConfig()
  const configuredPort = validPort(config.port)
  lanEnabled = config.lanEnabled === true
  const argument = process.argv.find((value) => value.startsWith('--api-port='))?.split('=')[1]
  apiPort = validPort(argument) || validPort(process.env.DX_DESKTOP_API_PORT) || configuredPort || DEFAULT_PACKAGED_API_PORT
  apiUrl = `http://127.0.0.1:${apiPort}`
  writeDesktopConfig({ port: apiPort, lanEnabled })
  desktopConfigSnapshot = JSON.stringify({ port: apiPort, lanEnabled, dataDirectory: String(config.dataDirectory || '') })
}

function defaultDataDirectory() {
  if (portableMode) return portableDataDirectory
  if (process.platform === 'darwin') return path.join(app.getPath('userData'), 'data')
  if (!process.env.LOCALAPPDATA) return path.join(app.getPath('userData'), 'data')
  return path.join(process.env.LOCALAPPDATA, 'DX OS', 'data')
}

function validDataDirectory(value) {
  const raw = String(value || '').trim()
  if (!raw || pathEncodingIsCorrupted(raw) || !path.isAbsolute(raw)) return ''
  const resolved = path.resolve(raw)
  if (resolved === path.parse(resolved).root) return ''
  return resolved
}

function softwareApiUrl() {
  const raw = String(process.env.DX_SOFTWARE_API_URL || 'https://api.dx-os.com').trim().replace(/\/+$/, '')
  const url = new URL(raw)
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !localHttp) throw new Error('软件更新接口必须使用 HTTPS；本机测试可以使用 localhost HTTP')
  return url.toString().replace(/\/+$/, '')
}

function compareDesktopVersions(left, right) {
  const parse = (value) => {
    const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
    return match ? { numbers: match.slice(1, 4).map(Number), prerelease: match[4] || '' } : null
  }
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return 0
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1
  }
  if (!a.prerelease && b.prerelease) return 1
  if (a.prerelease && !b.prerelease) return -1
  return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true })
}

async function checkAndDownloadSystemUpdate() {
  if (!app.isPackaged) return { status: 'development', message: '开发版不执行系统更新下载' }
  const result = await querySystemUpdate()
  if (result.status !== 'available') return result
  if (portableMode) {
    const changedComponents = portableChangedComponents(result.runtimeManifest)
    const changedCount = changedComponents.length
    if (!changedCount) throw new Error('更新服务器没有返回便携版组件清单')
    const totalBytes = changedComponents.reduce((sum, component) => sum + Number(component.archive?.fileSize || 0), 0)
    const confirm = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '便携版发现新版本',
      message: `发现 DX OS ${result.version}`,
      detail: `${result.notes ? `${result.notes}\n\n` : ''}本次只下载 ${changedCount} 个变化组件（约 ${formatByteSize(totalBytes)}），数据目录不会被替换。`,
      buttons: ['立即更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (confirm.response !== 0) return { status: 'available', version: result.version, portable: true, message: '发现新版本，已选择稍后更新' }
    await installPortableUpdate(result)
    return { status: 'installing', version: result.version, portable: true, message: `正在切换到 DX OS ${result.version}` }
  }
  if (result.mandatory && !portableMode) {
    await enforceMandatorySystemUpdate(result)
    return { status: 'installing', version: result.version, mandatory: true, message: `正在强制更新到 DX OS ${result.version}` }
  }
  const { version, downloadUrl, notes } = result
  const confirm = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '发现 DX OS 新版本',
    message: `发现 DX OS ${version}`,
    detail: `${notes ? `${notes}\n\n` : ''}将通过官方软件下载接口获取安装包。`,
    buttons: ['下载安装包', '稍后'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (confirm.response !== 0) return { status: 'available', version, message: '发现新版本，已选择稍后下载' }
  await shell.openExternal(downloadUrl)
  writeLog(`[updater] opened official package download; version=${version}`)
  return { status: 'available', version, downloadUrl, message: `已打开 DX OS ${version} 官方安装包下载` }
}

async function querySystemUpdate() {
  const apiBase = softwareApiUrl()
  const channel = 'stable'
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : ''
  const architecture = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : ''
  if (!platform || !architecture || (platform === 'windows' && architecture !== 'x64')) {
    return { status: 'unsupported', version: app.getVersion(), message: '当前平台暂不支持自动更新' }
  }
  const distribution = portableMode ? 'portable' : 'installer'
  const endpoint = `${apiBase}/v1/software/com.dxos.desktop/latest?platform=${platform}&architecture=${architecture}&channel=${channel}&distribution=${distribution}&currentVersion=${encodeURIComponent(app.getVersion())}&checkedAt=${Date.now()}`
  try {
    writeLog(`[updater] checking official release API ${endpoint}`)
    const response = await fetch(endpoint, { cache: 'no-store', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) })
    if (response.status === 404) {
      writeDesktopConfig({ softwareUpdateLastCheckedAt: Date.now() })
      return { status: 'unavailable', version: app.getVersion(), message: '当前更新通道暂未发布可用版本' }
    }
    if (!response.ok) throw new Error(`更新服务器返回 HTTP ${response.status}`)
    const result = await response.json()
    const version = String(result?.release?.version || '')
    writeDesktopConfig({ softwareUpdateLastCheckedAt: Date.now() })
    if (!version || result?.updateAvailable !== true) return { status: 'current', version: app.getVersion(), message: '当前已经是最新版本' }
    const downloadUrl = String(result?.artifact?.downloadUrl || '')
    const parsedDownloadUrl = new URL(downloadUrl)
    const localHttp = parsedDownloadUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsedDownloadUrl.hostname)
    if (parsedDownloadUrl.protocol !== 'https:' && !localHttp) throw new Error('更新安装包地址不是安全的 HTTPS 地址')
    const notes = String(result?.release?.releaseNotes || '').trim()
    const fileName = path.basename(String(result?.artifact?.fileName || ''))
    const fileSize = Number(result?.artifact?.fileSize)
    const sha256 = String(result?.artifact?.sha256 || '').toLowerCase()
    if (!fileName || !Number.isSafeInteger(fileSize) || fileSize < 1 || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error('更新服务器返回的安装包元数据无效')
    }
    const runtimeManifest = result?.runtimeManifest || result?.portable?.runtimeManifest || null
    return { status: 'available', version, downloadUrl, notes, mandatory: result?.mandatory === true,
      fileName, fileSize, sha256, platform, architecture,
      runtimeManifest,
      message: `发现 DX OS ${version} 新版本` }
  } catch (error) {
    throw new Error(`检查更新失败：${String(error?.message || error)}`)
  }
}

async function installInitialPortableUpdateIfNeeded() {
  if (!portableMode || smokeTest || portableUpdateSmokeTest || portableUpdateVerify) return false
  const marker = path.join(portableDataDirectory, '.initial-update-complete.json')
  if (existsSync(marker)) return false
  try {
    const result = await querySystemUpdate()
    if (result.status === 'available') {
      writeLog(`[updater] fresh portable baseline is converging ${app.getVersion()} -> ${result.version}`)
      await installPortableUpdate(result)
      return true
    }
    if (result.status === 'current') {
      writeFileSync(marker, `${JSON.stringify({ version: app.getVersion(), checkedAt: new Date().toISOString() })}\n`, 'utf8')
    }
  } catch (error) {
    writeLog(`[updater] initial portable update deferred: ${error?.stack || error}`)
  }
  return false
}

function mandatoryUpdatePage(version) {
  const safeVersion = String(version || '').replace(/[<>&"']/g, '')
  const html = `<!doctype html><meta charset="utf-8"><title>DX OS 必须更新</title><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#0f1117;color:#f5f7fb;font-family:system-ui,"Microsoft YaHei",sans-serif}.box{width:min(520px,calc(100% - 48px));text-align:center}.brand{font-size:13px;letter-spacing:.18em;color:#8ea5ff}.track{height:8px;margin:28px 0 12px;overflow:hidden;border-radius:99px;background:#252a37}.bar{width:0;height:100%;background:linear-gradient(90deg,#5b8cff,#8b6cff);transition:width .2s}.status{color:#aeb7c8;font-size:13px;line-height:1.7}small{display:block;margin-top:24px;color:#70798a}</style><div class="box"><div class="brand">DX OS SECURITY UPDATE</div><h1>必须更新到 ${safeVersion}</h1><p>当前版本存在重大修复，完成更新前不能继续使用 DX OS。</p><div class="track"><div class="bar" id="bar"></div></div><div class="status" id="status">正在连接官方更新服务器…</div><small>请不要关闭电脑或断开网络</small></div><script>window.dxMandatoryUpdateProgress=(percent,status)=>{document.getElementById('bar').style.width=Math.max(0,Math.min(100,Number(percent)||0))+'%';document.getElementById('status').textContent=String(status||'正在更新…')}</script>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function publishUpdateProgress(percent, transferred, total, status) {
  const progress = { percent: Math.max(0, Math.min(100, Number(percent) || 0)), transferred, total, status }
  mainWindow?.webContents.send('dx-desktop:update-progress', progress)
  if (mandatoryUpdateActive && mainWindow && !mainWindow.isDestroyed()) {
    void mainWindow.webContents.executeJavaScript(
      `window.dxMandatoryUpdateProgress?.(${JSON.stringify(progress.percent)},${JSON.stringify(status || '')})`
    ).catch(() => undefined)
  }
}

function formatByteSize(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

function safeRuntimePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '')
  const segments = normalized.split('/')
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`更新组件包含不安全路径：${String(value || '')}`)
  }
  return normalized
}

function runtimePath(root, relativePath) {
  return path.join(root, ...safeRuntimePath(relativePath).split('/'))
}

function rawRuntimeFileMetadata(file) {
  // Electron 会把任意名为 app.asar 的路径映射成虚拟目录。更新器校验的是
  // staging 中尚未激活的归档文件本体，必须临时绕过 ASAR 文件系统钩子。
  const previousNoAsar = process.noAsar
  process.noAsar = true
  try {
    const contents = readFileSync(file)
    return {
      size: statSync(file).size,
      sha256: createHash('sha256').update(contents).digest('hex').toLowerCase(),
    }
  } finally {
    process.noAsar = previousNoAsar
  }
}

function readRuntimeManifest(file) {
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function portableChangedComponents(manifest) {
  if (!Array.isArray(manifest?.components)) return []
  const current = readRuntimeManifest(path.join(portableRuntimeDirectory, '.dx-runtime-manifest.json'))
  const currentHashes = new Map((current?.components || []).map((component) => [component.id, component.contentHash]))
  return manifest.components.filter((component) => currentHashes.get(component.id) !== component.contentHash)
}

function linkRuntimeTree(source, target, relativePath = '', excludedPaths = new Set()) {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    // Manifest/version/health/ready 都属于单个运行时目录，绝不能硬链接到
    // staging；否则写入新版本标记会反向篡改仍在运行的 current。
    if (!relativePath && entry.name.startsWith('.dx-runtime-')) continue
    const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name
    // Never create a hard link for a file or directory that this update will
    // replace. On Windows the running Electron process keeps app.asar open; a
    // linked staging copy points to the same locked file and cannot be removed.
    if (excludedPaths.has(childRelative)) continue
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) linkRuntimeTree(from, to, childRelative, excludedPaths)
    else if (entry.isFile()) {
      try { linkSync(from, to) } catch { cpSync(from, to) }
    }
  }
}

function validatePortableManifest(manifest, expectedVersion) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.distribution !== 'portable'
    || String(manifest.version) !== String(expectedVersion) || manifest.platform !== 'windows'
    || manifest.architecture !== 'x64' || !Array.isArray(manifest.components) || !manifest.components.length) {
    throw new Error('便携版组件清单格式无效')
  }
  const ids = new Set()
  for (const component of manifest.components) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(String(component.id || '')) || ids.has(component.id)) throw new Error('便携版组件标识无效或重复')
    ids.add(component.id)
    if (!/^[a-f0-9]{64}$/i.test(String(component.contentHash || '')) || !Array.isArray(component.files)
      || !Array.isArray(component.replacePaths) || (!component.files.length && !component.replacePaths.length)) {
      throw new Error(`便携版组件 ${component.id} 元数据无效`)
    }
    for (const replacePath of component.replacePaths) safeRuntimePath(replacePath)
    for (const file of component.files) {
      safeRuntimePath(file?.path)
      if (!Number.isSafeInteger(Number(file?.size)) || Number(file.size) < 0 || !/^[a-f0-9]{64}$/i.test(String(file?.sha256 || ''))) {
        throw new Error(`便携版组件 ${component.id} 文件元数据无效`)
      }
    }
    const archive = component.archive
    if (!archive || path.basename(String(archive.fileName || '')) !== archive.fileName
      || !Number.isSafeInteger(Number(archive.fileSize)) || Number(archive.fileSize) < 1
      || !/^[a-f0-9]{64}$/i.test(String(archive.sha256 || ''))) throw new Error(`便携版组件 ${component.id} 归档元数据无效`)
    const url = new URL(String(archive.downloadUrl || ''))
    const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    if (url.protocol !== 'https:' && !localHttp) throw new Error(`便携版组件 ${component.id} 下载地址不安全`)
  }
}

async function downloadPortableComponent(component, destination, progressState) {
  const response = await fetch(component.archive.downloadUrl, {
    headers: { Accept: 'application/octet-stream' }, redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000),
  })
  if (!response.ok || !response.body) throw new Error(`下载组件 ${component.id} 失败：HTTP ${response.status}`)
  const finalUrl = new URL(response.url)
  const localHttp = finalUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(finalUrl.hostname)
  if (finalUrl.protocol !== 'https:' && !localHttp) throw new Error(`组件 ${component.id} 被重定向到不安全地址`)
  const partial = `${destination}.${randomUUID()}.partial`
  const hash = createHash('sha256')
  let received = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      progressState.transferred += chunk.length
      hash.update(chunk)
      const percent = Math.floor(progressState.transferred / progressState.total * 100)
      publishUpdateProgress(percent, progressState.transferred, progressState.total, `正在下载 ${component.id}… ${percent}%`)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(partial, { flags: 'wx' }))
    if (received !== Number(component.archive.fileSize)) throw new Error(`组件 ${component.id} 大小校验失败`)
    if (hash.digest('hex').toLowerCase() !== String(component.archive.sha256).toLowerCase()) throw new Error(`组件 ${component.id} SHA-256 校验失败`)
    renameSync(partial, destination)
  } catch (error) {
    try { unlinkSync(partial) } catch { /* ignore */ }
    throw error
  }
}

function extractPortableComponent(archive, staging) {
  const listing = spawnSync('tar.exe', ['-tf', archive], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  if (listing.error) throw listing.error
  if (listing.status !== 0) throw new Error(`无法读取更新组件：${listing.stderr || listing.stdout}`)
  for (const entry of String(listing.stdout || '').split(/\r?\n/).filter(Boolean)) {
    const cleaned = entry.replace(/\/$/, '')
    if (cleaned && cleaned !== '.') safeRuntimePath(cleaned)
  }
  const extracted = spawnSync('tar.exe', ['-xf', archive, '-C', staging], { encoding: 'utf8', windowsHide: true })
  if (extracted.error) throw extracted.error
  if (extracted.status !== 0) throw new Error(`解压更新组件失败：${extracted.stderr || extracted.stdout}`)
}

async function installPortableUpdate(result, restartArguments = []) {
  if (!portableMode || !portableRuntimeDirectory || process.platform !== 'win32') throw new Error('当前不是受支持的 Windows 便携版')
  const manifest = result.runtimeManifest
  validatePortableManifest(manifest, result.version)
  const runtimeRoot = path.join(portableRoot, '.dx-runtime')
  const current = portableRuntimeDirectory
  const safeVersion = String(result.version).replace(/[^0-9A-Za-z.-]/g, '-')
  const stagingDirectory = `runtime-${safeVersion}-${randomUUID()}`
  const staging = path.join(runtimeRoot, 'versions', stagingDirectory)
  const currentManifest = readRuntimeManifest(path.join(current, '.dx-runtime-manifest.json'))
  const changed = portableChangedComponents(manifest)
  if (!changed.length) throw new Error('服务器报告新版本，但运行组件没有变化')
  const cache = path.join(portableDataDirectory, 'cache', 'updates', String(result.version))
  try {
    mkdirSync(staging, { recursive: true })
    rmSync(cache, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    mkdirSync(cache, { recursive: true })
    const pathsToReplace = new Set()
    for (const component of changed) {
      const oldComponent = (currentManifest?.components || []).find((item) => item.id === component.id)
      for (const replacePath of [...(oldComponent?.replacePaths || []), ...component.replacePaths]) pathsToReplace.add(safeRuntimePath(replacePath))
      for (const file of [...(oldComponent?.files || []), ...component.files]) pathsToReplace.add(safeRuntimePath(file.path))
    }
    linkRuntimeTree(current, staging, '', pathsToReplace)
    const progressState = { transferred: 0, total: changed.reduce((sum, component) => sum + Number(component.archive.fileSize), 0) }
    for (const component of changed) {
      const archive = path.join(cache, component.archive.fileName)
      await downloadPortableComponent(component, archive, progressState)
      extractPortableComponent(archive, staging)
      for (const file of component.files) {
        const extracted = runtimePath(staging, file.path)
        if (!existsSync(extracted)) throw new Error(`更新后文件缺失：${file.path}`)
        const actual = rawRuntimeFileMetadata(extracted)
        if (actual.size !== Number(file.size) || actual.sha256 !== String(file.sha256).toLowerCase()) {
          throw new Error(`更新后文件校验失败：${file.path}；size=${actual.size}/${file.size}；sha256=${actual.sha256}/${file.sha256}`)
        }
      }
    }
    rmSync(path.join(staging, '.dx-runtime-health.json'), { force: true })
    writeFileSync(path.join(staging, '.dx-runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    writeFileSync(path.join(staging, '.dx-runtime-version.json'), `${JSON.stringify({ version: result.version, ready: true, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
    writeFileSync(path.join(staging, '.dx-runtime-ready.json'), `${JSON.stringify({ ready: true, version: result.version, preparedAt: new Date().toISOString() })}\n`, 'utf8')
    publishUpdateProgress(100, progressState.total, progressState.total, '更新已验证，正在重启并切换版本…')
    const child = spawn(portableLauncherPath, [
      `--wait-for-pid=${process.pid}`,
      `--staging-directory=${stagingDirectory}`,
      ...restartArguments,
    ], { detached: true, stdio: 'ignore', cwd: portableRoot, windowsHide: true })
    child.unref()
    writeLog(`[updater] portable staging prepared; version=${result.version}; components=${changed.map((item) => item.id).join(',')}`)
    quitting = true
    setTimeout(() => app.quit(), 500)
  } catch (error) {
    writeLog(`[updater] staging preparation failed: ${error?.stack || error}`)
    try {
      rmSync(staging, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    } catch (cleanupError) {
      writeLog(`[updater] staging cleanup deferred: ${cleanupError?.stack || cleanupError}`)
    }
    throw error
  }
}

async function downloadOfficialUpdate(result) {
  const updateDirectory = path.join(app.getPath('temp'), FILESYSTEM_APP_NAME, 'updates')
  mkdirSync(updateDirectory, { recursive: true })
  const safeName = path.basename(result.fileName)
  if (safeName !== result.fileName || !/^[A-Za-z0-9][A-Za-z0-9._ ()+-]{1,239}$/.test(safeName)) {
    throw new Error('安装包文件名无效')
  }
  const finalPath = path.join(updateDirectory, `${result.version}-${safeName}`)
  const partialPath = `${finalPath}.${randomUUID()}.partial`
  try { unlinkSync(partialPath) } catch { /* file does not exist */ }
  try { unlinkSync(finalPath) } catch { /* always download the current official artifact */ }

  const response = await fetch(result.downloadUrl, {
    headers: { Accept: 'application/octet-stream' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30 * 60 * 1000),
  })
  if (!response.ok || !response.body) throw new Error(`下载安装包失败：HTTP ${response.status}`)
  if (!response.url.startsWith('https://')) throw new Error('安装包下载被重定向到非 HTTPS 地址')

  const hash = createHash('sha256')
  let transferred = 0
  let lastPercent = -1
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      transferred += chunk.length
      hash.update(chunk)
      const percent = Math.floor((transferred / result.fileSize) * 100)
      if (percent !== lastPercent) {
        lastPercent = percent
        publishUpdateProgress(percent, transferred, result.fileSize, `正在下载安全更新… ${Math.min(100, percent)}%`)
      }
      callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partialPath, { flags: 'wx' }))
    if (transferred !== result.fileSize) throw new Error(`安装包大小校验失败：应为 ${result.fileSize}，实际为 ${transferred}`)
    if (hash.digest('hex') !== result.sha256) throw new Error('安装包 SHA-256 校验失败，已拒绝安装')
    renameSync(partialPath, finalPath)
    publishUpdateProgress(100, transferred, result.fileSize, '安全校验通过，正在启动安装程序…')
    return finalPath
  } catch (error) {
    try { unlinkSync(partialPath) } catch { /* partial file may not exist */ }
    throw error
  }
}

function launchOfficialInstaller(installerPath, result) {
  const extension = path.extname(installerPath).toLowerCase()
  let command = installerPath
  let args = []
  if (process.platform === 'win32' && extension === '.exe') args = ['/S', '--updated', '--force-run']
  else if (process.platform === 'win32' && extension === '.msi') {
    command = 'msiexec.exe'
    args = ['/i', installerPath, '/qn', '/norestart']
  } else if (process.platform === 'darwin' && ['.dmg', '.pkg'].includes(extension)) {
    command = 'open'
    args = [installerPath]
  } else throw new Error(`当前平台不能自动安装 ${extension || '未知格式'} 更新包`)

  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  writeDesktopConfig({ softwareUpdatePendingVersion: result.version, softwareUpdateInstallerPath: installerPath })
  writeLog(`[updater] mandatory installer launched; version=${result.version}; file=${installerPath}`)
  setTimeout(() => {
    quitting = true
    app.quit()
  }, 800)
}

async function installMandatorySystemUpdate(result) {
  mandatoryUpdateActive = true
  stopServices()
  if (mainWindow) {
    await mainWindow.loadURL(mandatoryUpdatePage(result.version))
    mainWindow.show()
    mainWindow.focus()
  }
  writeDesktopConfig({ mandatorySoftwareUpdate: result })
  writeLog(`[updater] mandatory update enforced; version=${result.version}`)
  const installerPath = await downloadOfficialUpdate(result)
  launchOfficialInstaller(installerPath, result)
}

async function enforceMandatorySystemUpdate(initialResult) {
  let discovered = initialResult
  if (!discovered) {
    try {
      discovered = await querySystemUpdate()
    } catch (error) {
      const cached = readDesktopConfig().mandatorySoftwareUpdate
      if (!cached || compareDesktopVersions(cached.version, app.getVersion()) <= 0) {
        writeLog(`[updater] startup update check unavailable; continuing without an unconfirmed mandatory release: ${error.message}`)
        return false
      }
      discovered = cached
      writeLog(`[updater] update server unavailable; enforcing cached mandatory version=${discovered.version}`)
    }
  }
  if (discovered.status !== 'available' || !discovered.mandatory) {
    writeDesktopConfig({ mandatorySoftwareUpdate: null })
    return false
  }
  while (!quitting) {
    try {
      await installMandatorySystemUpdate(discovered)
      return true
    } catch (error) {
      mandatoryUpdateActive = true
      writeLog(`[updater] mandatory update failed: ${error.stack || error.message}`)
      const retry = await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: '必须完成安全更新',
        message: 'DX OS 无法完成强制安全更新',
        detail: `${error.message}\n\n完成更新前不能继续使用。请检查网络后重试。`,
        buttons: ['重试更新', '退出 DX OS'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (retry.response !== 0) {
        quitting = true
        app.quit()
        return true
      }
    }
  }
  return true
}

async function checkSystemUpdateSilently() {
  try {
    const result = await querySystemUpdate()
    if (result.status !== 'available') {
      writeLog(`[updater] automatic check completed; status=${result.status}`)
      return true
    }
    if (result.mandatory && !portableMode) {
      await enforceMandatorySystemUpdate(result)
      return true
    }
    const config = readDesktopConfig()
    if (config.softwareUpdateLastNotifiedVersion === result.version) {
      writeLog(`[updater] automatic check found previously notified version=${result.version}`)
      return true
    }
    writeDesktopConfig({ softwareUpdateLastNotifiedVersion: result.version })
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: `DX OS ${result.version} 可以更新`,
        body: portableMode
          ? '便携版可以只下载发生变化的组件，打开 DX OS 一键更新。'
          : result.mandatory ? '这是一个重要更新。打开 DX OS，在系统信息中下载安装。' : '打开 DX OS，在“系统信息”中查看并下载安装。',
        icon: path.join(__dirname, 'assets', 'dx-os.ico'),
      })
      notification.on('click', () => {
        if (mainWindow?.isMinimized()) mainWindow.restore()
        mainWindow?.show()
        mainWindow?.focus()
      })
      notification.show()
    }
    writeLog(`[updater] automatic update notification shown; version=${result.version}`)
    return true
  } catch (error) {
    writeLog(`[updater] automatic check failed: ${error.stack || error.message}`)
    return false
  }
}

function scheduleAutomaticUpdateCheck(delayOverride) {
  if (!app.isPackaged || smokeTest || quitting) return
  if (softwareUpdateTimer) clearTimeout(softwareUpdateTimer)
  const lastCheckedAt = Number(readDesktopConfig().softwareUpdateLastCheckedAt || 0)
  const elapsed = Math.max(0, Date.now() - lastCheckedAt)
  const delay = Number.isFinite(delayOverride)
    ? delayOverride
    : lastCheckedAt > 0 ? Math.max(15_000, SOFTWARE_UPDATE_INTERVAL_MS - elapsed) : 15_000
  softwareUpdateTimer = setTimeout(async () => {
    softwareUpdateTimer = null
    const succeeded = await checkSystemUpdateSilently()
    scheduleAutomaticUpdateCheck(succeeded ? SOFTWARE_UPDATE_INTERVAL_MS : SOFTWARE_UPDATE_RETRY_MS)
  }, delay)
  softwareUpdateTimer.unref?.()
  writeLog(`[updater] next automatic check scheduled in ${Math.round(delay / 1000)} seconds`)
}

function directoryHasFiles(directory) {
  try { return existsSync(directory) && readdirSync(directory).length > 0 } catch { return false }
}

function copyDataDirectory(source, target) {
  if (!directoryHasFiles(source) || path.resolve(source).toLowerCase() === path.resolve(target).toLowerCase()) return false
  mkdirSync(target, { recursive: true })
  if (directoryHasFiles(target)) return false
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    cpSync(path.join(source, entry.name), path.join(target, entry.name), { recursive: true, force: false, errorOnExist: true })
  }
  return true
}

async function ensurePackagedDataDirectory() {
  if (isDevelopment) return
  if (portableMode) {
    dataDirectory = portableDataDirectory
    mkdirSync(dataDirectory, { recursive: true })
    writeDesktopConfig({ dataDirectory, pendingDataMigrationFrom: null })
    desktopConfigSnapshot = JSON.stringify({ port: apiPort, lanEnabled, dataDirectory })
    writeLog(`[desktop] portable data directory selected: ${dataDirectory}`)
    return
  }
  if (smokeTest) {
    dataDirectory = path.join(app.getPath('temp'), FILESYSTEM_APP_NAME, 'smoke-test', desktopRunId)
    return
  }
  const config = readDesktopConfig()
  const defaultDirectory = defaultDataDirectory()
  let selectedDirectory = validDataDirectory(config.dataDirectory)
  let migrationSource = validDataDirectory(config.pendingDataMigrationFrom)
  let installerSelection = ''
  const localRoot = platformAppDataRoot()
  const installerSelectionFiles = CONFIG_DIRECTORY_NAMES.map((name) =>
    path.join(localRoot, name, 'config', 'installer-data-directory.txt')
  )
  for (const installerSelectionFile of installerSelectionFiles) {
    if (!existsSync(installerSelectionFile)) continue
    try {
      installerSelection ||= validDataDirectory(decodeInstallerPath(readFileSync(installerSelectionFile)))
    } finally {
      try { unlinkSync(installerSelectionFile) } catch { /* retry is unnecessary; config remains safe */ }
    }
  }
  if (installerSelection) {
    if (selectedDirectory && selectedDirectory.toLowerCase() !== installerSelection.toLowerCase()) migrationSource = selectedDirectory
    else if (!selectedDirectory && directoryHasFiles(defaultDirectory) && defaultDirectory.toLowerCase() !== installerSelection.toLowerCase()) migrationSource = defaultDirectory
    selectedDirectory = installerSelection
    writeDesktopConfig({ dataDirectory: selectedDirectory, pendingDataMigrationFrom: migrationSource || null })
    writeLog(`[desktop] installer selected data directory: ${selectedDirectory}`)
  }

  if (!selectedDirectory) {
    const choice = await dialog.showMessageBox({
      type: 'question',
      title: '选择 DX OS 数据存储位置',
      message: 'DX OS 的项目、账户、APP 和任务数据保存在哪里？',
      detail: `程序安装位置和数据位置相互独立。默认位置：\n${defaultDirectory}\n\n系统会直接使用你选择的文件夹；如果选择磁盘根目录，则使用其中的“DX OS”文件夹。`,
      buttons: ['选择其他位置', '使用默认位置'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (choice.response === 0) {
      const picked = await dialog.showOpenDialog({
        title: '选择 DX OS 数据存储位置',
        defaultPath: path.dirname(defaultDirectory),
        properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
        buttonLabel: '选择此位置',
      })
      if (!picked.canceled && picked.filePaths[0]) {
        const pickedDirectory = path.resolve(picked.filePaths[0])
        selectedDirectory = pickedDirectory === path.parse(pickedDirectory).root
          ? path.join(pickedDirectory, FILESYSTEM_APP_NAME)
          : pickedDirectory
      }
    }
    selectedDirectory ||= defaultDirectory
    if (selectedDirectory !== defaultDirectory) copyDataDirectory(defaultDirectory, selectedDirectory)
    writeDesktopConfig({ dataDirectory: selectedDirectory, pendingDataMigrationFrom: null })
  } else if (migrationSource && migrationSource.toLowerCase() !== selectedDirectory.toLowerCase()) {
    const copied = copyDataDirectory(migrationSource, selectedDirectory)
    writeLog(`[desktop] data migration ${copied ? 'copied' : 'selected'}; from=${migrationSource}; to=${selectedDirectory}`)
    writeDesktopConfig({ dataDirectory: selectedDirectory, pendingDataMigrationFrom: null })
  }

  dataDirectory = selectedDirectory
  mkdirSync(dataDirectory, { recursive: true })
  desktopConfigSnapshot = JSON.stringify({ port: apiPort, lanEnabled, dataDirectory })
  writeLog(`[desktop] data directory selected: ${dataDirectory}`)
}

function watchDesktopConfig() {
  if (isDevelopment || !desktopConfigPath) return
  const timer = setInterval(() => {
    if (quitting) return
    const config = readDesktopConfig()
    const snapshot = JSON.stringify({ port: validPort(config.port) || DEFAULT_PACKAGED_API_PORT, lanEnabled: config.lanEnabled === true, dataDirectory: String(config.dataDirectory || '') })
    if (snapshot === desktopConfigSnapshot) return
    desktopConfigSnapshot = snapshot
    writeLog('[desktop] configuration changed; restarting DX OS')
    restartApplication()
  }, 800)
  timer.unref()
}

function pipeProcessLogs(child, name) {
  const outputPath = path.join(logDirectory, `${name}.log`)
  const errorPath = path.join(logDirectory, `${name}.error.log`)
  child.stdout?.on('data', (chunk) => {
    try { appendFileSync(outputPath, chunk) } catch { /* startup will report fatal failures */ }
  })
  child.stderr?.on('data', (chunk) => {
    try { appendFileSync(errorPath, chunk) } catch { /* startup will report fatal failures */ }
  })
  child.once('exit', (code, signal) => writeLog(`[${name}] exited code=${code} signal=${signal || 'none'}`))
  child.once('error', (error) => writeLog(`[${name}] process error: ${error.stack || error.message}`))
}

function packagedPaths() {
  const appRoot = app.getAppPath()
  const runtimeRoot = appRoot.endsWith('.asar')
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : appRoot
  return {
    appRoot,
    runtimeRoot,
    node: path.join(process.resourcesPath, 'runtime', 'node-runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
    tsx: path.join(runtimeRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    api: path.join(runtimeRoot, 'server', 'index.ts'),
    worker: path.join(runtimeRoot, 'server', 'worker.ts'),
  }
}

function assertPackagedFiles(paths) {
  for (const [name, target] of Object.entries(paths)) {
    if (!['appRoot', 'runtimeRoot'].includes(name) && !existsSync(target)) throw new Error(`封装资源缺失：${name}\n${target}`)
  }
}

function spawnRuntime(name, entry, paths, environment) {
  const child = spawn(paths.node, [paths.tsx, entry], {
    cwd: paths.runtimeRoot,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  pipeProcessLogs(child, name)
  return child
}

function preparePackagedServiceContext() {
  const paths = packagedPaths()
  assertPackagedFiles(paths)
  if (!dataDirectory) throw new Error('尚未选择 DX OS 数据存储位置')
  const npmCacheDirectory = smokeTest
    ? path.join(dataDirectory, 'npm-cache')
    : portableMode
    ? path.join(dataDirectory, 'cache', 'npm')
    : process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, FILESYSTEM_APP_NAME, 'cache', 'npm')
    : path.join(app.getPath('userData'), 'cache', 'npm')
  mkdirSync(dataDirectory, { recursive: true })
  mkdirSync(npmCacheDirectory, { recursive: true })
  const environment = {
    ...process.env,
    NODE_ENV: 'production',
    HOST: lanEnabled ? '0.0.0.0' : '127.0.0.1',
    PORT: String(apiPort),
    DX_DATA_DIR: dataDirectory,
    CCS_DATA_DIR: dataDirectory,
    NPM_CONFIG_CACHE: npmCacheDirectory,
    npm_config_cache: npmCacheDirectory,
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    DX_DESKTOP_VERSION: app.getVersion(),
    DX_DESKTOP_PID: String(process.pid),
    DX_DESKTOP_RUN_ID: desktopRunId,
    DX_DESKTOP_CONFIG_PATH: desktopConfigPath,
    DX_PORTABLE: portableMode ? '1' : '0',
  }
  return { paths, environment }
}

function startPackagedApi() {
  packagedServiceContext = preparePackagedServiceContext()
  const { paths, environment } = packagedServiceContext
  apiProcess = spawnRuntime('api', paths.api, paths, environment)
  writeLog(`[desktop] API started; data=${dataDirectory}`)
}

function startPackagedWorker() {
  if (!packagedServiceContext) packagedServiceContext = preparePackagedServiceContext()
  const { paths, environment } = packagedServiceContext
  workerProcess = spawnRuntime('worker', paths.worker, paths, environment)
  writeLog(`[desktop] Worker started; data=${dataDirectory}`)
}

async function waitForOwnedApi(timeoutMs, watchedProcess) {
  const url = `${apiUrl}/api/desktop/health`
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    if (watchedProcess.exitCode !== null) {
      throw new Error(`本地 API 提前退出，退出码 ${watchedProcess.exitCode}。请查看日志目录：${logDirectory}`)
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (response.ok) {
        const result = await response.json()
        if (result.desktopRunId === desktopRunId) return
        lastError = `端口 ${apiPort} 已被其他服务或旧版本占用`
      } else lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error.message
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`无法确认本次 DX OS 本地服务：${lastError}\n日志目录：${logDirectory}`)
}

async function waitForUrl(url, timeoutMs, watchedProcess) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    if (watchedProcess && watchedProcess.exitCode !== null) {
      throw new Error(`本地 API 提前退出，退出码 ${watchedProcess.exitCode}。请查看日志目录：${logDirectory}`)
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error.message
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`等待服务启动超时：${url}\n${lastError}\n日志目录：${logDirectory}`)
}

function loadingPage() {
  const html = `<!doctype html><meta charset="utf-8"><title>DX OS 正在启动</title><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#eef2f7;color:#1d2430;font-family:system-ui,"Microsoft YaHei",sans-serif}.box{text-align:center}.dot{width:34px;height:34px;margin:0 auto 18px;border:3px solid #cbd4e1;border-top-color:#4f72d8;border-radius:50%;animation:s .8s linear infinite}@keyframes s{to{transform:rotate(360deg)}}small{color:#7b8798}</style><div class="box"><div class="dot"></div><h2>DX OS 正在启动</h2><small>正在准备本地服务与 Agent Worker…</small></div>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'DX OS',
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#eef2f7',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'dx-os.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    else writeLog(`[desktop] blocked unsupported external URL: ${url}`)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith(apiUrl) || (isDevelopment && url.startsWith(DEV_URL)) || url.startsWith('data:')
    if (!allowed) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => {
    if (mandatoryUpdateActive && !quitting) {
      event.preventDefault()
      mainWindow.show()
      mainWindow.focus()
      return
    }
    if (!quitting && !smokeTest) {
      event.preventDefault()
      mainWindow.hide()
      writeLog('[desktop] main window hidden to tray')
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
  void mainWindow.loadURL(loadingPage())
}

ipcMain.handle('dx-desktop:get-info', () => ({
  packaged: app.isPackaged,
  portable: portableMode,
  version: app.getVersion(),
  dataDirectory,
  updateUrl: String(process.env.DX_UPDATE_URL || readDesktopConfig().updateUrl || '').trim(),
}))

ipcMain.handle('dx-desktop:choose-data-parent', async () => {
  if (portableMode) return portableDataDirectory
  const current = validDataDirectory(readDesktopConfig().dataDirectory) || defaultDataDirectory()
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: '选择 DX OS 数据存储位置',
    defaultPath: path.dirname(current),
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    buttonLabel: '选择此位置',
  })
  if (picked.canceled || !picked.filePaths[0]) return ''
  const pickedDirectory = path.resolve(picked.filePaths[0])
  return pickedDirectory === path.parse(pickedDirectory).root
    ? path.join(pickedDirectory, FILESYSTEM_APP_NAME)
    : pickedDirectory
})

ipcMain.handle('dx-desktop:check-update', async () => {
  try { return await checkAndDownloadSystemUpdate() }
  catch (error) {
    writeLog(`[updater] ${error.stack || error.message}`)
    return { status: 'error', message: String(error.message || error) }
  }
})

function toggleWindow() {
  if (!mainWindow) return
  if (mainWindow.isVisible()) mainWindow.hide()
  else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

function restartApplication() {
  quitting = true
  app.relaunch({ args: process.argv.slice(1) })
  app.quit()
}

function setLanEnabled(enabled) {
  if (isDevelopment || !desktopConfigPath) return
  writeDesktopConfig({ port: apiPort, lanEnabled: enabled })
  lanEnabled = enabled
  restartApplication()
}

function createTray() {
  if (tray || (smokeTest && !traySmokeTest)) return
  const iconPath = path.join(__dirname, 'assets', process.platform === 'darwin' ? 'dx-os-trayTemplate.png' : 'dx-os-tray.png')
  const trayImage = nativeImage.createFromPath(iconPath)
  const fallbackImage = nativeImage.createFromPath(path.join(__dirname, 'assets', 'dx-os.png'))
  const sourceImage = trayImage.isEmpty() ? fallbackImage : trayImage
  if (process.platform === 'darwin') sourceImage.setTemplateImage(true)
  // Windows 的 ICO 会优先选取 16px 图层，视觉上比相邻软件小一圈。
  // 使用专用 PNG 并明确给出 20px 托盘尺寸，使有效图形填满系统托盘槽位。
  const displayImage = process.platform === 'win32'
    ? sourceImage.resize({ width: 20, height: 20, quality: 'best' })
    : sourceImage
  tray = new Tray(displayImage)
  tray.setToolTip('DX OS')
  const rebuildMenu = () => {
    const openAtLogin = app.getLoginItemSettings().openAtLogin
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: mainWindow?.isVisible() ? '隐藏 DX OS' : '显示 DX OS', click: toggleWindow },
      { type: 'separator' },
      { label: '开放局域网访问', type: 'checkbox', checked: lanEnabled, enabled: !isDevelopment, click: (item) => setLanEnabled(item.checked) },
      { label: '开机自动启动', type: 'checkbox', checked: openAtLogin, enabled: app.isPackaged, click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, path: portableLauncherPath })
        rebuildMenu()
      } },
      { type: 'separator' },
      { label: '退出 DX OS', click: () => { quitting = true; app.quit() } },
    ]))
  }
  tray.on('click', toggleWindow)
  tray.on('right-click', rebuildMenu)
  rebuildMenu()
  writeLog(`[desktop] tray created; icon=${iconPath}; size=${process.platform === 'win32' ? '20x20' : 'native'}`)
}

function stopProcessTree(child, name) {
  if (!child || child.exitCode !== null || !child.pid) return
  writeLog(`[desktop] stopping ${name} pid=${child.pid}`)
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

function stopServices() {
  stopProcessTree(workerProcess, 'worker')
  stopProcessTree(apiProcess, 'api')
  workerProcess = null
  apiProcess = null
  packagedServiceContext = null
}

async function startApplication() {
  if (!portableMode) app.setAppLogsPath()
  logDirectory = app.getPath('logs')
  mkdirSync(logDirectory, { recursive: true })
  loadPackagedConfig()
  desktopRunId = randomUUID()
  await ensurePackagedDataDirectory()
  if (!isDevelopment && pathEncodingIsCorrupted(process.resourcesPath)) {
    throw new Error(`程序安装路径已经发生编码损坏：${process.resourcesPath}\n请卸载旧版后重新安装到 D:\\DXOS 等路径。`)
  }
  writeLog(`[desktop] DX OS ${app.getVersion()} starting; packaged=${app.isPackaged}; apiPort=${apiPort}; lanEnabled=${lanEnabled}`)
  createWindow()
  createTray()
  watchDesktopConfig()
  try {
    if (isDevelopment) {
      await Promise.all([
        waitForUrl(`${apiUrl}/api/auth/status`, 90_000),
        waitForUrl(DEV_URL, 90_000),
      ])
      await mainWindow.loadURL(DEV_URL)
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    } else {
      if (!smokeTest && !portableMode && await enforceMandatorySystemUpdate()) return
      // API 先独占完成 SQLite 初始化与迁移，确认健康后才启动 Worker，
      // 避免两套 Node 进程在首次启动时同时切换 WAL/执行迁移。
      startPackagedApi()
      await waitForOwnedApi(90_000, apiProcess)
      startPackagedWorker()
      if (smokeTest) {
        writeLog('[desktop] packaged smoke test passed; quitting')
        setTimeout(() => app.quit(), 800)
        return
      }
      await mainWindow.loadURL(apiUrl)
    }
    writeLog('[desktop] main window ready')
    if (portableMode) {
      writeFileSync(path.join(portableRuntimeDirectory, '.dx-runtime-health.json'), `${JSON.stringify({
        healthy: true,
        version: app.getVersion(),
        checkedAt: new Date().toISOString(),
      })}\n`, 'utf8')
    }
    if (portableUpdateSmokeTest) {
      const update = await querySystemUpdate()
      if (update.status !== 'available') throw new Error(`便携增量实测没有发现目标版本：${update.status}`)
      writeLog(`[updater-smoke] starting real component update ${app.getVersion()} -> ${update.version}`)
      await installPortableUpdate(update, ['--portable-update-verify', `--api-port=${apiPort}`])
      return
    }
    if (portableUpdateVerify) {
      writeLog(`[updater-smoke] activated version ${app.getVersion()} is healthy`)
      setTimeout(() => app.quit(), 800)
      return
    }
    if (await installInitialPortableUpdateIfNeeded()) return
    scheduleAutomaticUpdateCheck()
  } catch (error) {
    writeLog(`[desktop] startup failed: ${error.stack || error.message}`)
    if (portableUpdateSmokeTest || portableUpdateVerify) {
      quitting = true
      app.quit()
      return
    }
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'DX OS 启动失败',
      message: 'DX OS 未能完成启动。',
      detail: `${error.message}\n\n日志目录：${logDirectory}`,
    })
    app.quit()
  }
}

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  app.whenReady().then(startApplication).catch((error) => {
    writeLog(`[desktop] fatal startup failure: ${error?.stack || error?.message || error}`)
    dialog.showErrorBox('DX OS 启动失败', `${String(error?.message || error)}\n\n日志目录：${logDirectory || '尚未创建'}`)
    app.quit()
  })
}

app.on('window-all-closed', () => {
  if (process.platform === 'darwin' && !quitting) return
})
app.on('before-quit', () => {
  quitting = true
  if (softwareUpdateTimer) clearTimeout(softwareUpdateTimer)
  softwareUpdateTimer = null
  stopServices()
})
