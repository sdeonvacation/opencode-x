import fs from "fs/promises"

const BOM_CODE = 0xfeff
const BOM = String.fromCharCode(BOM_CODE)

export function split(text: string) {
  if (text.charCodeAt(0) !== BOM_CODE) return { bom: false, text }
  return { bom: true, text: text.slice(1) }
}

export function join(text: string, bom: boolean) {
  const stripped = split(text).text
  if (!bom) return stripped
  return BOM + stripped
}

export async function read(filePath: string) {
  return split(await fs.readFile(filePath, "utf-8"))
}

export async function sync(filePath: string, bom: boolean) {
  const current = await read(filePath)
  if (current.bom === bom) return current.text
  await fs.writeFile(filePath, join(current.text, bom), "utf-8")
  return current.text
}
