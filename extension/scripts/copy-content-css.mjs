// Post-build: copy content.css to dist/content/
import { cpSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const src = resolve(root, 'src/content/content.css')
const dest = resolve(root, 'dist/content/content.css')

mkdirSync(resolve(root, 'dist/content'), { recursive: true })
cpSync(src, dest)
console.log('Copied content.css → dist/content/content.css')
