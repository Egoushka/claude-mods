import type { Register } from 'claude-code'

import { matches, parseList } from './diet'

export const register: Register = (on, options) => {
  const patterns = parseList(typeof options.tools === 'string' ? options.tools : '')
  if (patterns.length === 0) return

  on('tool.describe', async ($, e, next) => {
    const result = await next(e)
    return matches(e.tool, patterns) ? { ...result, isDeferred: true } : result
  })
}
