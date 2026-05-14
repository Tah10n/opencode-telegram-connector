import { formatMarkdownToTelegramHtmlBlocks } from "../../telegram/formatter.js"

export function formatUserMirrorBlocks(text) {
  const blocks = formatMarkdownToTelegramHtmlBlocks(text)
  if (blocks.length > 0) {
    blocks[0] = { ...blocks[0], html: `<i>User:</i>\n${blocks[0].html}` }
  }
  return blocks
}
