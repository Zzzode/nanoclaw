const EDGE_ALLOWED_TOOLS = [
  'workspace.read',
  'workspace.list',
  'workspace.search',
  'workspace.write',
  'workspace.apply_patch',
  'message.send',
  'task.create',
  'task.list',
  'task.delete',
  'task.update',
  'http.fetch',
  'js.exec',
] as const;

export const EDGE_ALLOWED_TOOL_SET = new Set<string>(EDGE_ALLOWED_TOOLS);
export const EDGE_SHADOW_ALLOWED_TOOLS = [
  'workspace.read',
  'workspace.list',
  'workspace.search',
] as const;
export const EDGE_SHADOW_ALLOWED_TOOL_SET = new Set<string>(
  EDGE_SHADOW_ALLOWED_TOOLS,
);

export function parseRequestedEdgeTool(
  prompt: string | undefined,
): string | null {
  if (!prompt) return null;
  const trimmed = prompt.trim();
  const prefix = 'EDGE_TOOL ';
  if (!trimmed.startsWith(prefix)) return null;

  try {
    const payload = JSON.parse(trimmed.slice(prefix.length)) as unknown;
    if (
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      typeof (payload as { tool?: unknown }).tool === 'string'
    ) {
      return (payload as { tool: string }).tool;
    }
  } catch {
    return null;
  }

  return null;
}

export function edgeToolIsSupported(tool: string | null | undefined): boolean {
  return typeof tool === 'string' && EDGE_ALLOWED_TOOL_SET.has(tool);
}

const TOOL_CAPABILITY_MAP: Record<string, string[]> = {
  'workspace.read': ['fs.read'],
  'workspace.list': ['fs.read'],
  'workspace.search': ['fs.read'],
  'workspace.write': ['fs.write'],
  'workspace.apply_patch': ['fs.write'],
  'message.send': ['message.send'],
  'task.create': ['task.manage'],
  'task.list': ['task.manage'],
  'task.delete': ['task.manage'],
  'task.update': ['task.manage'],
  'http.fetch': ['http.fetch'],
  'js.exec': ['code.exec'],
};

export function deriveCapabilitiesFromTools(tools: Iterable<string>): string[] {
  const capabilities = new Set<string>();
  for (const tool of tools) {
    for (const capability of TOOL_CAPABILITY_MAP[tool] ?? []) {
      capabilities.add(capability);
    }
  }
  return [...capabilities];
}
