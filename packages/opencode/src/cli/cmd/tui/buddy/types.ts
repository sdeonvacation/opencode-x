export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const
export type Rarity = (typeof RARITIES)[number]

export const SPECIES = [
  "duck",
  "goose",
  "blob",
  "cat",
  "dragon",
  "octopus",
  "owl",
  "penguin",
  "turtle",
  "snail",
  "ghost",
  "axolotl",
  "capybara",
  "cactus",
  "robot",
  "rabbit",
  "mushroom",
  "chonk",
] as const
export type Species = (typeof SPECIES)[number]

// Compatibility re-exports for computed-key usage in sprites.ts
export const duck = "duck" as const
export const goose = "goose" as const
export const blob = "blob" as const
export const cat = "cat" as const
export const dragon = "dragon" as const
export const octopus = "octopus" as const
export const owl = "owl" as const
export const penguin = "penguin" as const
export const turtle = "turtle" as const
export const snail = "snail" as const
export const ghost = "ghost" as const
export const axolotl = "axolotl" as const
export const capybara = "capybara" as const
export const cactus = "cactus" as const
export const robot = "robot" as const
export const rabbit = "rabbit" as const
export const mushroom = "mushroom" as const
export const chonk = "chonk" as const

export const EYES = ["·", "✦", "×", "◉", "@", "°"] as const
export type Eye = (typeof EYES)[number]

export const HATS = ["none", "crown", "tophat", "propeller", "halo", "wizard", "beanie", "tinyduck"] as const
export type Hat = (typeof HATS)[number]

export const STAT_NAMES = ["DEBUGGING", "PATIENCE", "CHAOS", "WISDOM", "SNARK"] as const
export type StatName = (typeof STAT_NAMES)[number]

// Deterministic parts — derived from hash(userId)
export type CompanionBones = {
  rarity: Rarity
  species: Species
  eye: Eye
  hat: Hat
  shiny: boolean
  stats: Record<StatName, number>
}

// Model-generated soul — stored in config after first hatch
export type CompanionSoul = {
  name: string
  personality: string
  seed?: string
}

export type Companion = CompanionBones &
  CompanionSoul & {
    hatchedAt: number
  }

// What actually persists in config. Bones are regenerated from hash(userId)
// on every read so species renames don't break stored companions and users
// can't edit their way to a legendary.
export type StoredCompanion = CompanionSoul & { hatchedAt: number }

export const RARITY_WEIGHTS = {
  common: 60,
  uncommon: 25,
  rare: 10,
  epic: 4,
  legendary: 1,
} as const satisfies Record<Rarity, number>

export const RARITY_STARS = {
  common: "★",
  uncommon: "★★",
  rare: "★★★",
  epic: "★★★★",
  legendary: "★★★★★",
} as const satisfies Record<Rarity, string>

export const SPECIES_NAMES: Record<string, string> = {
  duck: "Waddles",
  goose: "Honk",
  blob: "Blobby",
  cat: "Whiskers",
  dragon: "Ember",
  octopus: "Inky",
  owl: "Hoot",
  penguin: "Tux",
  turtle: "Shell",
  snail: "Slime",
  ghost: "Boo",
  axolotl: "Axle",
  capybara: "Capy",
  cactus: "Prick",
  robot: "Beep",
  rabbit: "Bun",
  mushroom: "Spore",
  chonk: "Chonky",
}

export const SPECIES_PERSONALITY: Record<string, string> = {
  duck: "Cheerful and easily distracted by shiny objects",
  goose: "Chaotic and unpredictable, honks at everything",
  blob: "Calm and gelatinous, absorbs all problems",
  cat: "Aloof but secretly invested in your success",
  dragon: "Dramatic and intense, takes code very seriously",
  octopus: "Clever and multitasking, always has eight solutions",
  owl: "Wise and patient, offers cryptic but useful advice",
  penguin: "Formal and efficient, runs on fish and logic",
  turtle: "Slow but steady, never panics under pressure",
  snail: "Optimistic and methodical, enjoys the journey",
  ghost: "Mysterious and ethereal, haunts your bugs",
  axolotl: "Regenerative and curious, adapts to everything",
  capybara: "Relaxed and wholesome, vibes with all creatures",
  cactus: "Prickly exterior, warm heart, thrives in dry conditions",
  robot: "Precise and logical, speaks in binary when excited",
  rabbit: "Quick and energetic, bounces between ideas",
  mushroom: "Networked and philosophical, thinks in mycelium",
  chonk: "Large and in charge, moves at their own pace",
}

// Maps rarity to opencode theme color key
export const RARITY_COLOR_KEY = {
  common: "textMuted",
  uncommon: "success",
  rare: "info",
  epic: "accent",
  legendary: "warning",
} as const satisfies Record<Rarity, string>
