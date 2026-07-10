const BLOCKED_SUBAGENT_TOOLS = new Set(['subagent', 'task']);

let subagentsEnabled = true;
let subagentPolicyConfigured = false;

export function initializeSubagentsEnabled(enabled: boolean): void {
    if (subagentPolicyConfigured) return;
    subagentsEnabled = enabled;
    subagentPolicyConfigured = true;
}

export function setSubagentsEnabled(enabled: boolean): void {
    subagentsEnabled = enabled;
    subagentPolicyConfigured = true;
}

export function isSubagentsEnabled(): boolean {
    return subagentsEnabled;
}

function getToolName(tool: any): string | null {
    const name = tool?.function?.name ?? tool?.name;
    return typeof name === 'string' ? name : null;
}

function isBlockedToolName(name: unknown): boolean {
    return typeof name === 'string' && BLOCKED_SUBAGENT_TOOLS.has(name.toLowerCase());
}

export function applySubagentPolicy(json: any): string[] {
    if (subagentsEnabled || !Array.isArray(json?.tools)) return [];

    const removed: string[] = [];
    json.tools = json.tools.filter((tool: any) => {
        const name = getToolName(tool);
        if (!isBlockedToolName(name)) return true;
        removed.push(name!);
        return false;
    });

    const forcedToolName = json.tool_choice?.function?.name ?? json.tool_choice?.name;
    if (isBlockedToolName(forcedToolName)) {
        json.tool_choice = 'auto';
    }
    if (json.tools.length === 0) {
        const choiceType = typeof json.tool_choice === 'string'
            ? json.tool_choice
            : json.tool_choice?.type;
        if (choiceType === 'required' || choiceType === 'any') {
            json.tool_choice = 'none';
        }
    }

    return removed;
}
