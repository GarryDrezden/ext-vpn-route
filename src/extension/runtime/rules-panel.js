import {
  BROWSER_ROUTING_WRITE_CAPABILITY,
  ServiceWriteErrorCode,
  WriterErrorCode,
  syncAfterBrowserRoutingWrite
} from "../state/browser-routing-write-contract.js";

export const RulesMessage = Object.freeze({
  writeUnsupported: "Текущая версия VPN Route не поддерживает изменение правил из расширения.",
  stateUnavailable: "Не удалось загрузить правила из VPN Route Service.",
  conflict: "Правила изменились в другом окне. Список обновлён — проверьте изменения и сохраните ещё раз.",
  ambiguous: "Не удалось подтвердить результат. Обновляем состояние…",
  notFound: "Правило уже удалено. Список обновлён.",
  validation: "Проверьте поля правила и попробуйте снова."
});

const AMBIGUOUS_WRITE_CODES = new Set([
  WriterErrorCode.Timeout,
  WriterErrorCode.TransportUnavailable,
  WriterErrorCode.HostError
]);

const SERVICE_DOWN_HOST = new Set(["service_unavailable", "service_timeout", "service_error", "service_untrusted"]);

/** @param {any} snapshotFetch provider getSnapshot() result */
export function buildRulesPanelView(snapshotFetch) {
  if (!snapshotFetch || snapshotFetch.ok !== true || !snapshotFetch.snapshot) {
    return Object.freeze({
      available: false,
      writable: false,
      identity: null,
      defaultRoute: null,
      rules: Object.freeze([]),
      hint: null
    });
  }
  const integration = snapshotFetch.integration;
  const writable = Boolean(integration && integration.hasCapability(BROWSER_ROUTING_WRITE_CAPABILITY));
  const rules = [...snapshotFetch.snapshot.state.rules].sort((a, b) => a.id.localeCompare(b.id));
  return Object.freeze({
    available: true,
    writable,
    identity: Object.freeze({ ...snapshotFetch.snapshot.identity }),
    defaultRoute: snapshotFetch.snapshot.state.defaultRoute,
    rules: Object.freeze(rules.map((rule) => Object.freeze({ ...rule }))),
    hint: writable ? null : RulesMessage.writeUnsupported
  });
}

export function buildFixtureRulesPanelView(builtInState) {
  if (!builtInState || !Array.isArray(builtInState.rules)) {
    return Object.freeze({
      available: false,
      writable: false,
      identity: null,
      defaultRoute: null,
      rules: Object.freeze([]),
      hint: RulesMessage.writeUnsupported
    });
  }
  const rules = [...builtInState.rules].sort((a, b) => a.id.localeCompare(b.id));
  return Object.freeze({
    available: true,
    writable: false,
    identity: Object.freeze({ stateGeneration: "fixture", revision: builtInState.revision ?? 0 }),
    defaultRoute: builtInState.defaultRoute ?? "Direct",
    rules: Object.freeze(rules.map((rule) => Object.freeze({ ...rule }))),
    hint: RulesMessage.writeUnsupported
  });
}

function isAmbiguousWriteFailure(writeResult) {
  if (!writeResult || writeResult.ok) return false;
  const code = writeResult.error && writeResult.error.code;
  if (AMBIGUOUS_WRITE_CODES.has(code)) {
    if (code === WriterErrorCode.HostError) {
      return SERVICE_DOWN_HOST.has(writeResult.error.hostErrorCode);
    }
    return true;
  }
  return false;
}

/**
 * @param {{
 *   getSnapshot: () => Promise<any>,
 *   writer: object with upsertRule/deleteRule/resetRules,
 *   sync: (reason: string) => Promise<any>,
 *   formatView: (view: any) => any
 * }} deps
 */
export async function executeRulesMutation(deps, action, payload) {
  const snapshotFetch = await deps.getSnapshot();
  const panelBefore = buildRulesPanelView(snapshotFetch);
  if (!panelBefore.available) {
    return Object.freeze({ ok: false, code: "state_unavailable", message: RulesMessage.stateUnavailable, panel: panelBefore });
  }
  if (!panelBefore.writable) {
    return Object.freeze({ ok: false, code: "write_unsupported", message: RulesMessage.writeUnsupported, panel: panelBefore });
  }
  const integration = snapshotFetch.integration;
  const expectedRevision = panelBefore.identity.revision;

  let writeResult;
  if (action === "upsert") {
    writeResult = await deps.writer.upsertRule({ integration, expectedRevision, rule: payload.rule });
  } else if (action === "delete") {
    writeResult = await deps.writer.deleteRule({ integration, expectedRevision, id: payload.id });
  } else if (action === "reset") {
    writeResult = await deps.writer.resetRules({ integration, expectedRevision });
  } else {
    return Object.freeze({ ok: false, code: "invalid_action", message: "Unknown mutation.", panel: panelBefore });
  }

  if (writeResult.ok) {
    const synced = await syncAfterBrowserRoutingWrite({ sync: deps.sync }, writeResult, "post-write");
    const fresh = buildRulesPanelView(await deps.getSnapshot());
    return Object.freeze({
      ok: true,
      writeResult,
      view: deps.formatView(synced.sync),
      panel: fresh,
      userMessage: null
    });
  }

  const errCode = writeResult.error && writeResult.error.code;
  if (errCode === ServiceWriteErrorCode.RevisionConflict) {
    await deps.sync("post-write-conflict");
    const fresh = buildRulesPanelView(await deps.getSnapshot());
    return Object.freeze({
      ok: false,
      code: "revision_conflict",
      conflict: true,
      writeResult,
      panel: fresh,
      userMessage: RulesMessage.conflict
    });
  }

  if (errCode === ServiceWriteErrorCode.NotFound) {
    await deps.sync("post-write-not-found");
    const fresh = buildRulesPanelView(await deps.getSnapshot());
    return Object.freeze({
      ok: false,
      code: "not_found",
      writeResult,
      panel: fresh,
      userMessage: RulesMessage.notFound
    });
  }

  if (isAmbiguousWriteFailure(writeResult)) {
    await deps.sync("post-write-verify");
    const fresh = buildRulesPanelView(await deps.getSnapshot());
    return Object.freeze({
      ok: false,
      code: "ambiguous_transport",
      ambiguous: true,
      writeResult,
      panel: fresh,
      userMessage: RulesMessage.ambiguous
    });
  }

  if (errCode === ServiceWriteErrorCode.ValidationFailed || errCode === ServiceWriteErrorCode.InvalidRequest) {
    return Object.freeze({
      ok: false,
      code: "validation_failed",
      writeResult,
      panel: panelBefore,
      userMessage: (writeResult.error && writeResult.error.message) || RulesMessage.validation
    });
  }

  return Object.freeze({
    ok: false,
    code: errCode || "write_failed",
    writeResult,
    panel: panelBefore,
    userMessage: (writeResult.error && writeResult.error.message) || "Не удалось выполнить операцию."
  });
}
