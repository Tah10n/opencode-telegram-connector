import { formatMarkdownToTelegramHtmlBlocks } from "../../telegram/formatter.js"
import { splitTelegramHtml } from "../../telegram/client.js"

export function formatUserMirrorBlocks(text) {
  const blocks = formatMarkdownToTelegramHtmlBlocks(text)
  if (blocks.length > 0) {
    blocks[0] = { ...blocks[0], html: `<i>User:</i>\n${blocks[0].html}` }
  }
  return blocks.flatMap((block) => {
    if (block?.type !== "text" || typeof block.html !== "string") return [block]
    return splitTelegramHtml(block.html).map((html) => ({ ...block, html }))
  })
}
