export { discover, readConfigFile, knownConfigPaths, parseJsonc } from './discover.js'
export { diagnoseServer, diagnoseAll, staticChecks, resolveCommand, classifyStderr } from './diagnose.js'
export { probeRemote, classifyHttpProbe, classifyNetworkError, oauthMetadataUrl, readRpcBody } from './remote.js'
export type { HttpProbe, RemoteResult } from './remote.js'
export {
  diagnoseLogs,
  analyzeLogFile,
  analyzeLogText,
  classifyLogLine,
  discoverLogFiles,
  knownLogDirs,
  findLogFiles,
  serverNameFromLogPath,
  tail,
} from './logs.js'
export { redactSecrets, quoteLine, redactSpecSecrets } from './redact.js'
export { renderTerminal } from './report/terminal.js'
export { McpClient, StdioTransport, HttpTransport } from './client/index.js'
export { VERSION } from './version.js'
export type { Diagnosis, Finding, ServerSpec, Verdict, WtfOptions, WtfReport } from './types.js'
