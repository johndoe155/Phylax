// @vitest-environment jsdom
/**
 * RENDER SMOKE TEST
 *
 * Executes the real component tree — every section, the real demo store, the
 * real engine — through react-dom/server. This is not a screenshot test; it is
 * a check that the app actually renders without throwing and that the derived
 * content is present and correct.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { App } from '../src/App'
import { buildSeed } from '../src/data/seed'
import { DEFAULT_ENGINE_OPTIONS, findConflicts } from '../src/engine'
import { FACILITIES, PLATFORMS } from '../src/data/seed'
import { useDemo } from '../src/store/demo'

let html = ''

/** Reverse the handful of entities React's server renderer emits. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/<!-- -->/g, '')
}

beforeEach(() => {
  useDemo.getState().reset()
  html = renderToString(createElement(App))
})

describe('full-page render', () => {
  it('renders without throwing and produces real content', () => {
    expect(html.length).toBeGreaterThan(20_000)
  })

  it('renders the headline', () => {
    expect(html).toContain('Never get')
    expect(html).toContain('booked')
    expect(html).toContain('twice.')
  })

  it('renders all thirteen sections with their ids', () => {
    for (const id of [
      'top',
      'gap',
      'collision',
      'loop',
      'zero-typing',
      'engine',
      'policy',
      'board',
      'alerts',
      'boundary',
      'pricing',
      'trust',
    ]) {
      expect(html, `missing section #${id}`).toContain(`id="${id}"`)
    }
  })

  it('names all five platforms in copy, without using their logos', () => {
    for (const p of PLATFORMS) {
      expect(html, `missing platform ${p.name}`).toContain(p.name)
    }
    // Decision: real names in text only — no third-party logo assets.
    expect(html).not.toMatch(/<img[^>]+(shiftkey|carerev|clipboard|shiftmed|intelycare)/i)
  })

  it('shows the engine-computed hero conflict, not scripted copy', () => {
    const seed = buildSeed(useDemo.getState().today)
    const ctx = {
      facilities: new Map(FACILITIES.map((f) => [f.id, f])),
      platforms: new Map(PLATFORMS.map((p) => [p.id, p])),
      options: DEFAULT_ENGINE_OPTIONS,
    }
    const expected = findConflicts(seed.shifts[0], seed.shifts, ctx)[0]

    expect(expected).toBeDefined()
    expect(expected.severity).toBe('critical')
    // The exact engine message must reach the DOM. React HTML-escapes the
    // apostrophe in "St. Anne's", so decode entities before comparing — the
    // content is what we are asserting, not the serializer's escaping.
    expect(decodeEntities(html)).toContain(expected.message)
  })

  it('marks the midnight-crossing shift in the UI', () => {
    expect(html).toContain('crosses midnight')
  })

  it('surfaces the §10.3 policy disclaimer verbatim', () => {
    expect(html).toContain('Illustrative policy data for demonstration only')
    expect(html).toContain('verify current platform policy')
  })

  it('includes the non-affiliation notice required by the trademark decision', () => {
    expect(html).toContain('not affiliated with, endorsed by, or sponsored by')
  })

  it('has a skip link and labelled navigation for assistive tech', () => {
    expect(html).toContain('Skip to content')
    expect(html).toContain('aria-label="Footer"')
  })

  it('renders a live timer role for the cancellation countdown', () => {
    expect(html).toContain('role="timer"')
  })
})
