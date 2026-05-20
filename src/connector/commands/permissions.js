import { makeInlineKeyboard } from "../../telegram/client.js"
import {
  CUSTOM_PERMISSION_PROFILE_ID,
  normalizePermissionProfileId,
  OPENCODE_DEFAULT_PROFILE_ID,
  permissionProfileLabel,
  PERMISSION_PROFILE_IDS,
  PERMISSION_RESET_ID,
} from "../../opencode/permissions-profile.js"
import { readOpenCodePermissionConfig, writeOpenCodePermissionProfile } from "../../opencode/permissions-config.js"
import { t as translate } from "../../i18n/index.js"
import { callbackPacker } from "./shared.js"

function isPrivateChat(ctxMeta) {
  return ctxMeta?.chatType === "private"
}

function projectLabel(projects, projectAlias) {
  const displayName = projects?.[projectAlias]?.displayName
  return displayName ? `${projectAlias} (${displayName})` : projectAlias
}

function profileLabel(profileId, locale, t) {
  const key = {
    suggest: "permissions.profileSuggest",
    "auto-edit": "permissions.profileAutoEdit",
    "full-auto": "permissions.profileFullAuto",
    [OPENCODE_DEFAULT_PROFILE_ID]: "permissions.profileDefault",
    [CUSTOM_PERMISSION_PROFILE_ID]: "permissions.profileCustom",
  }[profileId]
  return key ? t(locale, key) : permissionProfileLabel(profileId)
}

function configStatusLabel(status, locale, t) {
  const key = {
    ok: "permissions.statusOk",
    missing: "permissions.statusMissing",
    unavailable: "permissions.statusUnavailable",
    disabled: "permissions.statusDisabled",
    invalid: "permissions.statusInvalid",
  }[status]
  return key ? t(locale, key) : status || "unknown"
}

function compactJson(value, maxChars = 2400) {
  if (value == null) return "(not configured)"
  const text = JSON.stringify(value, null, 2)
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...` : text
}

export function createPermissionCommandHandlers(deps) {
  const {
    store,
    projects,
    sendToThread,
    tg,
    cb,
    unboundGuidanceText,
    unboundGuidanceKeyboard,
    readPermissionConfig = readOpenCodePermissionConfig,
    writePermissionProfile = writeOpenCodePermissionProfile,
    t = (ctxOrLocale, key, params) => translate(typeof ctxOrLocale === "string" ? ctxOrLocale : ctxOrLocale?.locale, key, params),
  } = deps
  const packCallback = callbackPacker(cb)

  function boundProjectAlias(ctxMeta) {
    return store.getBinding(ctxMeta.ctxKey)?.projectAlias || ""
  }

  function canWrite(ctxMeta) {
    return isPrivateChat(ctxMeta)
  }

  function profileButton(profileId, locale, projectAlias) {
    const action = profileId === "full-auto" ? "confirm" : "set"
    return { text: profileLabel(profileId, locale, t), callback_data: packCallback("pc", action, projectAlias, profileId) }
  }

  function settingsKeyboard(ctxMeta, projectAlias, readResult) {
    const locale = ctxMeta?.locale || "en"
    const rows = []
    if (readResult?.editable !== false && canWrite(ctxMeta)) {
      rows.push(PERMISSION_PROFILE_IDS.slice(0, 2).map((profileId) => profileButton(profileId, locale, projectAlias)))
      rows.push([profileButton("full-auto", locale, projectAlias)])
      rows.push([{ text: t(locale, "permissions.resetButton"), callback_data: packCallback("pc", "reset", projectAlias) }])
    }
    rows.push([{ text: t(locale, "permissions.viewCurrent"), callback_data: packCallback("pc", "view", projectAlias) }])
    rows.push([{ text: t(locale, "common.close"), callback_data: packCallback("pc", "close") }])
    return makeInlineKeyboard(rows)
  }

  function projectPickerKeyboard(ctxMeta) {
    const locale = ctxMeta?.locale || "en"
    const rows = Object.keys(projects || {}).sort().map((projectAlias) => [
      { text: projectLabel(projects, projectAlias), callback_data: packCallback("pc", "project", projectAlias) },
    ])
    rows.push([{ text: t(locale, "common.close"), callback_data: packCallback("pc", "close") }])
    return makeInlineKeyboard(rows)
  }

  function detailsKeyboard(locale, projectAlias) {
    return makeInlineKeyboard([
      [{ text: t(locale, "model.back"), callback_data: packCallback("pc", "project", projectAlias) }],
      [{ text: t(locale, "common.close"), callback_data: packCallback("pc", "close") }],
    ])
  }

  function confirmFullAutoKeyboard(locale, projectAlias) {
    return makeInlineKeyboard([
      [{ text: t(locale, "permissions.confirmFullAutoButton"), callback_data: packCallback("pc", "apply", projectAlias, "full-auto") }],
      [
        { text: t(locale, "common.cancel"), callback_data: packCallback("pc", "project", projectAlias) },
        { text: t(locale, "common.close"), callback_data: packCallback("pc", "close") },
      ],
    ])
  }

  function settingsText(ctxMeta, projectAlias, readResult, { noticeText = "" } = {}) {
    const locale = ctxMeta?.locale || "en"
    const lines = []
    if (noticeText) lines.push(noticeText, "")
    lines.push(t(locale, "permissions.title"))
    lines.push(t(locale, "permissions.project", { project: projectLabel(projects, projectAlias) }))
    lines.push(t(locale, "permissions.currentProfile", { profile: profileLabel(readResult?.profile, locale, t) }))
    if (readResult?.filePath) lines.push(t(locale, "permissions.configPath", { path: readResult.filePath }))
    lines.push(t(locale, "permissions.status", { status: configStatusLabel(readResult?.status, locale, t) }))
    if (!canWrite(ctxMeta)) lines.push(t(locale, "permissions.privateWriteOnly"))
    if (readResult?.status === "unavailable") lines.push(t(locale, "permissions.noConfigPath"))
    if (readResult?.status === "disabled") lines.push(t(locale, "permissions.disabled"))
    if (readResult?.status === "invalid") lines.push(t(locale, "permissions.invalidConfig"))
    lines.push("", t(locale, "permissions.suggestDescription"))
    lines.push(t(locale, "permissions.autoEditDescription"))
    lines.push(t(locale, "permissions.fullAutoDescription"))
    lines.push("", t(locale, "permissions.restartHint"))
    return lines.join("\n")
  }

  async function editOrSend(ctxMeta, editMessageId, text, replyMarkup) {
    if (editMessageId && tg?.editMessageText) {
      await tg.editMessageText(ctxMeta.chatId, editMessageId, text, replyMarkup)
      return
    }
    await sendToThread(ctxMeta, text, replyMarkup)
  }

  async function renderProjectPicker(ctxMeta, { editMessageId } = {}) {
    const text = [t(ctxMeta, "permissions.chooseProject"), t(ctxMeta, "permissions.chooseProjectHint")].join("\n")
    await editOrSend(ctxMeta, editMessageId, text, projectPickerKeyboard(ctxMeta))
  }

  async function renderPermissionSettings(ctxMeta, { projectAlias, editMessageId, noticeText = "" } = {}) {
    const requestedAlias = projectAlias || ""
    const currentBoundAlias = boundProjectAlias(ctxMeta)
    if (requestedAlias && !isPrivateChat(ctxMeta) && requestedAlias !== currentBoundAlias) {
      await sendToThread(ctxMeta, unboundGuidanceText(ctxMeta, t(ctxMeta, "commands.unbound.permissionsNeedsBound")), unboundGuidanceKeyboard(ctxMeta))
      return
    }
    const alias = requestedAlias || currentBoundAlias
    if (!alias) {
      if (isPrivateChat(ctxMeta)) {
        await renderProjectPicker(ctxMeta, { editMessageId })
        return
      }
      await sendToThread(ctxMeta, unboundGuidanceText(ctxMeta, t(ctxMeta, "commands.unbound.permissionsNeedsBound")), unboundGuidanceKeyboard(ctxMeta))
      return
    }
    const project = projects?.[alias]
    if (!project) {
      await editOrSend(ctxMeta, editMessageId, t(ctxMeta, "sessions.unknownProject"), makeInlineKeyboard([[{ text: t(ctxMeta, "common.close"), callback_data: packCallback("pc", "close") }]]))
      return
    }
    const readResult = await readPermissionConfig(project)
    await editOrSend(ctxMeta, editMessageId, settingsText(ctxMeta, alias, readResult, { noticeText }), settingsKeyboard(ctxMeta, alias, readResult))
  }

  async function renderPermissionDetails(ctxMeta, projectAlias, { editMessageId } = {}) {
    const locale = ctxMeta?.locale || "en"
    if (projectAlias && !isPrivateChat(ctxMeta) && projectAlias !== boundProjectAlias(ctxMeta)) {
      await sendToThread(ctxMeta, unboundGuidanceText(ctxMeta, t(ctxMeta, "commands.unbound.permissionsNeedsBound")), unboundGuidanceKeyboard(ctxMeta))
      return
    }
    const project = projects?.[projectAlias]
    if (!project) {
      await editOrSend(ctxMeta, editMessageId, t(ctxMeta, "sessions.unknownProject"), makeInlineKeyboard([[{ text: t(ctxMeta, "common.close"), callback_data: packCallback("pc", "close") }]]))
      return
    }
    const readResult = await readPermissionConfig(project)
    const lines = [
      t(locale, "permissions.currentRawTitle"),
      t(locale, "permissions.project", { project: projectLabel(projects, projectAlias) }),
      t(locale, "permissions.currentProfile", { profile: profileLabel(readResult?.profile, locale, t) }),
      readResult?.filePath ? t(locale, "permissions.configPath", { path: readResult.filePath }) : "",
      "",
      compactJson(readResult?.permission),
    ].filter(Boolean)
    await editOrSend(ctxMeta, editMessageId, lines.join("\n"), detailsKeyboard(locale, projectAlias))
  }

  async function renderFullAutoConfirmation(ctxMeta, projectAlias, { editMessageId } = {}) {
    const locale = ctxMeta?.locale || "en"
    const text = [
      t(locale, "permissions.fullAutoConfirmTitle"),
      t(locale, "permissions.project", { project: projectLabel(projects, projectAlias) }),
      "",
      t(locale, "permissions.fullAutoConfirmBody"),
    ].join("\n")
    await editOrSend(ctxMeta, editMessageId, text, confirmFullAutoKeyboard(locale, projectAlias))
  }

  async function applyPermissionProfile(ctxMeta, projectAlias, profileId, { editMessageId } = {}) {
    const project = projects?.[projectAlias]
    if (!project) {
      await editOrSend(ctxMeta, editMessageId, t(ctxMeta, "sessions.unknownProject"), makeInlineKeyboard([[{ text: t(ctxMeta, "common.close"), callback_data: packCallback("pc", "close") }]]))
      return { ok: false }
    }
    if (!canWrite(ctxMeta)) {
      await editOrSend(ctxMeta, editMessageId, t(ctxMeta, "permissions.privateWriteOnly"), makeInlineKeyboard([[{ text: t(ctxMeta, "common.close"), callback_data: packCallback("pc", "close") }]]))
      return { ok: false }
    }

    const result = await writePermissionProfile(project, profileId)
    if (!result?.ok) {
      await editOrSend(ctxMeta, editMessageId, t(ctxMeta, "permissions.writeUnavailable"), makeInlineKeyboard([[{ text: t(ctxMeta, "common.close"), callback_data: packCallback("pc", "close") }]]))
      return result
    }

    const normalizedProfile = normalizePermissionProfileId(profileId, { includeReset: true })
    const noticeText = normalizedProfile === PERMISSION_RESET_ID
      ? t(ctxMeta, "permissions.resetChanged")
      : t(ctxMeta, "permissions.changed", { profile: profileLabel(normalizedProfile, ctxMeta?.locale || "en", t) })
    await renderPermissionSettings(ctxMeta, { projectAlias, editMessageId, noticeText })
    return result
  }

  function parsePermissionCommand(ctxMeta, argv) {
    const bindingAlias = boundProjectAlias(ctxMeta)
    const first = String(argv?.[0] || "").trim()
    const second = String(argv?.[1] || "").trim()
    const firstProfile = normalizePermissionProfileId(first, { includeReset: true })
    const secondProfile = normalizePermissionProfileId(second, { includeReset: true })

    if (bindingAlias && (!first || firstProfile)) return { projectAlias: bindingAlias, profileId: firstProfile }
    if (first && projects?.[first] && isPrivateChat(ctxMeta)) return { projectAlias: first, profileId: secondProfile }
    if (first && projects?.[first]) return { projectAlias: "", profileId: "", invalid: false }
    if (bindingAlias && first && !firstProfile) return { projectAlias: bindingAlias, invalid: true }
    return { projectAlias: "", profileId: firstProfile, invalid: !!first }
  }

  async function handlePermissionsCommand(ctxMeta, argv = []) {
    const parsed = parsePermissionCommand(ctxMeta, argv)
    if (parsed.invalid) {
      await sendToThread(ctxMeta, t(ctxMeta, "permissions.usage"))
      return
    }
    if (!parsed.projectAlias) {
      if (isPrivateChat(ctxMeta)) {
        await renderProjectPicker(ctxMeta)
      } else {
        await sendToThread(ctxMeta, unboundGuidanceText(ctxMeta, t(ctxMeta, "commands.unbound.permissionsNeedsBound")), unboundGuidanceKeyboard(ctxMeta))
      }
      return
    }
    if (!parsed.profileId) {
      await renderPermissionSettings(ctxMeta, { projectAlias: parsed.projectAlias })
      return
    }
    if (parsed.profileId === "full-auto") {
      if (!canWrite(ctxMeta)) {
        await sendToThread(ctxMeta, t(ctxMeta, "permissions.privateWriteOnly"))
        return
      }
      await renderFullAutoConfirmation(ctxMeta, parsed.projectAlias)
      return
    }
    await applyPermissionProfile(ctxMeta, parsed.projectAlias, parsed.profileId)
  }

  return {
    applyPermissionProfile,
    renderPermissionDetails,
    renderPermissionSettings,
    renderFullAutoConfirmation,
    handlePermissionsCommand,
  }
}
