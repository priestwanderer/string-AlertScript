import { pathToFileURL } from 'node:url';
import { serveUi } from '../src/ui-server.js';

// This preview is isolated from .env, production servers, and webhook delivery.
export const previewConfig = {
  preview: true,
  webhookUrl: '', quotaRemainPercent: 20, cooldownMinutes: 60,
  checkIntervalMinutes: 60, pageSize: 100, timeoutMs: 30000,
  servers: [
    { id: 'japan', name: '日本站', estimatedCostThreshold: 500 },
    { id: 'us', name: '美国站', estimatedCostThreshold: 500 }
  ].map((server) => ({ ...server, enabled: true, monitorAllAccounts: true, groupScope: 'all', groups: [], baseUrl: '', email: '', password: '' }))
};

export const previewViews = {
  japan: {
    id: 'japan', name: '日本站', threshold: 500, lowGroupCount: 1, urgentAccountCount: 3, all: null, error: null,
    groups: [
      { id: 1, name: 'OpenAI 主力账号', estimatedCost: 328.46, usedCost: 1172.83, low: true, urgentCount: 2, accounts: [
        { id: 1, name: 'codex-team-01', platform: 'openai', estimatedCost: 128.64, usedCost: 436.28, windows: [{ windowName: '5h', remainingPercent: 12 }, { windowName: '7d', remainingPercent: 3 }] },
        { id: 2, name: 'workspace-02@example.invalid', platform: 'openai', estimatedCost: 89.32, usedCost: 521.65, windows: [{ windowName: '7d', remainingPercent: 8 }] }
      ] },
      { id: 2, name: 'Claude 团队', estimatedCost: 1456.8, usedCost: 683.25, low: false, urgentCount: 1, accounts: [
        { id: 3, name: 'claude-production', platform: 'anthropic', estimatedCost: 476.52, usedCost: 248.16, windows: [{ windowName: '5h', remainingPercent: 16 }] }
      ] }
    ]
  },
  us: {
    id: 'us', name: '美国站', threshold: 500, lowGroupCount: 1, urgentAccountCount: 1,
    all: { estimatedCost: 286.4, usedCost: 1923.6, accountCount: 8 }, error: null,
    groups: [
      { id: 1, name: 'OpenAI 备用账号', estimatedCost: 286.4, usedCost: 1923.6, low: true, urgentCount: 1, accounts: [
        { id: 4, name: 'codex-backup-01', platform: 'openai', estimatedCost: 96.48, usedCost: 723.12, windows: [{ windowName: '5h', remainingPercent: 0 }, { windowName: '7d', remainingPercent: 6 }] }
      ] }
    ]
  }
};

function rejectMutation() {
  throw Object.assign(new Error('界面预览模式，不会保存配置或发送告警'), { statusCode: 403 });
}

export function openPreview(port = 0) {
  return serveUi({
    host: '127.0.0.1', port,
    loadConfig: async () => previewConfig,
    saveConfig: rejectMutation,
    listGroups: async () => [],
    checkOnce: rejectMutation,
    scheduleStatus: async () => ({ enabled: false, running: false }),
    setSchedule: rejectMutation,
    monitorSnapshot: async (id) => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return { generatedAt: new Date().toISOString(), ...(id ? { server: previewViews[id] } : { servers: Object.values(previewViews) }) };
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { address } = await openPreview(Number(process.env.PREVIEW_PORT || 8790));
  console.log(`Isolated UI preview (fixture data only, no notifications): ${address}`);
}
