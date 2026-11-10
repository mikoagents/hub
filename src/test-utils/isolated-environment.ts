/** Tooling and transport settings only. Runtime configuration must be supplied explicitly. */
export function isolatedProcessEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "COMSPEC",
    "DOCKER_HOST",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE",
    "TESTCONTAINERS_HOST_OVERRIDE",
    "CI",
  ]) {
    if (parent[key] !== undefined) environment[key] = parent[key];
  }
  return { ...environment, ...overrides };
}
