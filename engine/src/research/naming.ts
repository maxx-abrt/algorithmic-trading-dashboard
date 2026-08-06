/**
 * Memorable model naming — generates names like "Swift Falcon", "Bold Tiger".
 * Used to give each trained model a human-friendly identity instead of a hash.
 */

const ADJECTIVES = [
  'Swift', 'Bold', 'Calm', 'Fierce', 'Noble', 'Silent', 'Golden', 'Crimson',
  'Azure', 'Emerald', 'Shadow', 'Radiant', 'Steady', 'Keen', 'Wise', 'Brave',
  'Lunar', 'Solar', 'Arctic', 'Cosmic', 'Iron', 'Silver', 'Storm', 'Frost',
  'Amber', 'Jade', 'Onyx', 'Coral', 'Sage', 'Vivid', 'Rapid', 'Solid',
  'Primal', 'Elite', 'Grand', 'Sharp', 'Quick', 'Mighty', 'Clean', 'Pure',
]

const ANIMALS = [
  'Falcon', 'Tiger', 'Panda', 'Eagle', 'Wolf', 'Lion', 'Hawk', 'Bear',
  'Fox', 'Owl', 'Shark', 'Bull', 'Stallion', 'Panther', 'Falcon', 'Raven',
  'Cobra', 'Lynx', 'Otter', 'Bison', 'Crane', 'Viper', 'Jaguar', 'Heron',
  'Mantis', 'Puma', 'Orca', 'Moose', 'Gecko', 'Koala', 'Ibex', 'Narwhal',
]

const used = new Set<string>()

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/** Generate a unique display name like "Swift Falcon". */
export function generateModelName(): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const name = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`
    if (!used.has(name)) {
      used.add(name)
      return name
    }
  }
  // Fallback: append a number
  const base = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`
  let n = 2
  while (used.has(`${base} ${n}`)) n++
  const name = `${base} ${n}`
  used.add(name)
  return name
}

/** Format a model display name with version: "Swift Falcon v1.2". */
export function formatModelName(displayName: string | null, version: string | null): string {
  if (!displayName && !version) return 'heuristic-baseline'
  if (!displayName) return version ?? 'unknown'
  if (!version) return displayName
  return `${displayName} v${version}`
}
