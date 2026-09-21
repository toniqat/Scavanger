/**
 * src/enemies/models/FactionLooks.ts — **the android · raider looks** (2026-09-13).
 *
 * Both use the rogue's humanoid rig (`RogueModel.createRogueRig`) as it is: the same groups · the same pivots · the same
 * muzzle (`gun` local (-0.1, -0.13, 1.1)) · the same leg lengths, so not one line of the AI animation or the hit capsule
 * changes. All that changes is the **geometry and materials** hung on each group. There is not one light — everything that glows is `eyeMat` emissive.
 *
 *   - **Android** — the butler/guard robot of labs · outposts. A matt white shell, a slim waist (a graphite spine
 *     column), an egg-shaped head with a black face plate + **a single lens**, glowing rings at the waist · hips · knees ·
 *     elbows · shoulders, a core light on the sternum. No cloth · skin · pack. Its gun too is a white-shelled carbine + a glowing strip along the side.
 *   - **Raider** — a pirate crew that arrives by ship. Poncho-style armour plates · magazine pouches over a black combat
 *     suit, a red chest band · red shoulder-pad tops · a red armband, a combat helmet (cheek guards · respirator filters ·
 *     an NVG mount · a red crown stripe) + **a wide amber visor band**, a big backpack and a **radio antenna** with an amber-glowing tip (what tells the silhouette apart at 40–60 m). A black rifle with a suppressor.
 *
 * The rogue · boss · named looks are built by `RogueModel.buildRogue` as before (this file knows nothing about them).
 */
import * as THREE from 'three';
import {
  SHIN, THIGH, ball, box, disc, eyeMaterial, grenadeGeometry, grenadeMaterial, limb, merge, ring, type HumanoidAssets,
} from './HumanoidParts';

/* ── Android ────────────────────────────────────────────────────────────── */
const AN = {
  shell: 0xd6d9de,     // matt white shell
  panel: 0xaeb3bb,     // one tone darker: panels · seams
  joint: 0x2a2e35,     // graphite joints · spine
  glass: 0x15181d,     // face plate
  gunShell: 0xc4c8ce,
  gunDark: 0x3a3e45,
  glow: 0x52d6ff,      // lens · joint rings (eyeMat)
} as const;
const ANDROID_EYE_GLOW = 2.4;

export function buildAndroid(): HumanoidAssets {
  const c = AN;
  const W = 0xffffff;   // glow parts: vertex colour is ignored by eyeMat, only there so the merge has one attribute set
  const pelvis = merge([
    box(0.26, 0.14, 0.19, 0, -0.03, 0, c.shell),                 // hip shell
    box(0.3, 0.05, 0.2, 0, -0.1, 0, c.joint),                    // joint housing under it
    box(0.12, 0.09, 0.03, 0, -0.03, 0.105, c.panel),             // front panel
    limb(0, 0.02, 0, 0, 0.16, 0, 0.07, c.joint, 1),              // spine column up to the torso pivot
  ]);
  const pelvisGlow = merge([
    ring(0.075, 0.011, 0.13, -0.08, 0, 'x', W),                  // hip rings (thighs swing about X — the ring stays aligned)
    ring(0.075, 0.011, -0.13, -0.08, 0, 'x', W),
  ]);
  const chest = merge([
    limb(0, 0, 0, 0, 0.2, 0, 0.08, c.joint, 1),                  // abdomen column — the slim robot waist
    box(0.22, 0.09, 0.16, 0, 0.2, 0, c.panel),                   // lower rib ring
    box(0.3, 0.1, 0.2, 0, 0.27, 0.005, c.shell),                 // chest taper
    box(0.38, 0.28, 0.22, 0, 0.41, 0, c.shell),                  // chest shell
    box(0.22, 0.16, 0.03, 0, 0.42, 0.115, c.panel),              // sternum panel
    box(0.2, 0.05, 0.03, 0, 0.535, 0.1, c.joint),                // collar seam
    box(0.1, 0.24, 0.07, 0, 0.38, -0.13, c.joint),               // power spine on the back
    box(0.24, 0.05, 0.02, 0, 0.3, -0.115, c.panel),              // back seam
    ball(0.085, 0.23, 0.5, 0, c.shell, 1, 0.9, 1),               // shoulder domes
    ball(0.085, -0.23, 0.5, 0, c.shell, 1, 0.9, 1),
    limb(0, 0.54, 0.01, 0, 0.7, 0.02, 0.038, c.joint, 1),        // neck
  ]);
  const chestGlow = merge([
    ring(0.088, 0.012, 0, 0.1, 0, 'y', W),                       // waist ring
    disc(0.034, 0.012, 0, 0.43, 0.133, W),                       // core light on the sternum
    ring(0.07, 0.01, 0.28, 0.5, 0, 'x', W),                      // shoulder rings
    ring(0.07, 0.01, -0.28, 0.5, 0, 'x', W),
  ]);
  const head = merge([
    ball(0.118, 0, 0.03, -0.005, c.shell, 0.92, 1.12, 1.02),     // egg cranium
    box(0.17, 0.11, 0.06, 0, -0.01, 0.085, c.glass),             // dark face plate
    disc(0.042, 0.05, 0.105, 0.01, -0.005, c.panel, 'x'),        // audio receptors
    disc(0.042, 0.05, -0.105, 0.01, -0.005, c.panel, 'x'),
    box(0.035, 0.03, 0.2, 0, 0.155, -0.01, c.panel),             // crest ridge
    limb(0, -0.12, 0, 0, -0.05, 0, 0.034, c.joint, 1),           // neck top
  ]);
  const visor = merge([
    disc(0.036, 0.02, 0, 0.0, 0.121, W),                         // the single lens
  ]);
  const gunArms = merge([
    limb(0, 0, 0, 0.02, -0.16, 0.24, 0.036, c.shell),            // right upper arm
    ball(0.04, 0.02, -0.16, 0.24, c.joint),                      // elbow
    limb(0.02, -0.16, 0.24, -0.08, -0.2, 0.42, 0.031, c.panel),  // forearm → grip
    box(0.05, 0.06, 0.06, -0.08, -0.21, 0.42, c.joint),          // hand
    limb(-0.46, 0, 0, -0.3, -0.2, 0.3, 0.036, c.shell),          // left upper arm
    ball(0.04, -0.3, -0.2, 0.3, c.joint),
    limb(-0.3, -0.2, 0.3, -0.12, -0.22, 0.56, 0.031, c.panel),   // left forearm → foregrip
    box(0.05, 0.06, 0.06, -0.12, -0.23, 0.56, c.joint),
    box(0.07, 0.1, 0.5, -0.1, -0.15, 0.48, c.gunShell),          // carbine body
    box(0.05, 0.06, 0.34, -0.1, -0.13, 0.9, c.gunDark),          // barrel shroud (ends at the muzzle)
    box(0.05, 0.12, 0.07, -0.1, -0.25, 0.36, c.gunDark),         // grip
    box(0.06, 0.08, 0.14, -0.1, -0.17, 0.17, c.gunShell),        // stock
  ]);
  const armsGlow = merge([
    ring(0.046, 0.009, 0.02, -0.16, 0.24, 'x', W),               // elbow rings
    ring(0.046, 0.009, -0.3, -0.2, 0.3, 'x', W),
    box(0.012, 0.018, 0.4, -0.064, -0.13, 0.5, W),               // light strip along the carbine
  ]);
  const thigh = merge([
    ball(0.062, 0, 0, 0, c.joint),                               // hip ball
    limb(0, -0.03, 0, 0, -THIGH + 0.05, 0, 0.06, c.shell, 0.8),
    box(0.1, 0.16, 0.05, 0, -0.2, 0.05, c.panel),                // thigh plate
  ]);
  const shin = merge([
    ball(0.05, 0, 0, 0, c.joint),                                // knee ball
    limb(0, -0.03, 0, 0, -SHIN + 0.06, 0, 0.05, c.shell, 1.15),
    box(0.09, 0.06, 0.2, 0, -SHIN + 0.035, 0.05, c.shell),       // foot
    box(0.095, 0.02, 0.21, 0, -SHIN + 0.0, 0.05, c.joint),       // sole
  ]);
  const shinGlow = merge([ring(0.058, 0.01, 0, 0, 0, 'x', W)]);   // knee ring
  return {
    pelvis, chest, head, visor, gunArms, thigh, shin, grenade: grenadeGeometry(),
    glow: { pelvis: pelvisGlow, chest: chestGlow, gunArms: armsGlow, shin: shinGlow },
    chitin: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.42, metalness: 0.08, emissive: 0x000000 }),
    eye: eyeMaterial(c.glow, ANDROID_EYE_GLOW),
    grenadeMat: grenadeMaterial(),
    eyeGlow: ANDROID_EYE_GLOW,
  };
}

/* ── Raider ─────────────────────────────────────────────────────────────── */
const RD = {
  suit: 0x1c1d20,      // black combat suit
  armor: 0x2e3035,     // armour plates · helmet
  plate: 0x3c3f45,     // one tone lighter plates (so the outline does not smear)
  strap: 0x121315,     // belt · boots · suppressor
  pouch: 0x2f3129,
  red: 0xb3221a,       // red markings
  metal: 0x4a4d52,
  /* Visor · antenna tip (eyeMat) — amber. A red visor belongs to the rogue boss (rogue_boss), so on the same black ·
     red body the two have to read apart, and this puts the raider in one warm family with the named raiders (Roden amber · Tagilla orange · Heavy yellow). */
  glow: 0xff8a1c,
} as const;
const RAIDER_EYE_GLOW = 2.2;

export function buildRaider(): HumanoidAssets {
  const c = RD;
  const W = 0xffffff;
  const pelvis = merge([
    box(0.36, 0.2, 0.26, 0, -0.02, 0, c.suit),
    box(0.38, 0.06, 0.28, 0, 0.08, 0, c.strap),                  // belt
    box(0.07, 0.05, 0.02, 0, 0.08, 0.145, c.red),                // buckle
    box(0.18, 0.15, 0.05, 0, -0.06, 0.14, c.armor),              // groin plate
    box(0.08, 0.14, 0.12, 0.21, -0.02, 0.02, c.pouch),           // hip pouches
    box(0.08, 0.14, 0.12, -0.21, -0.02, 0.02, c.pouch),
  ]);
  const chest = merge([
    box(0.44, 0.5, 0.28, 0, 0.3, 0, c.suit),
    box(0.47, 0.36, 0.13, 0, 0.36, 0.1, c.armor),                // plate carrier, front
    box(0.45, 0.34, 0.08, 0, 0.36, -0.16, c.armor),              // back plate
    box(0.09, 0.13, 0.07, -0.12, 0.25, 0.19, c.pouch),           // magazine pouches
    box(0.09, 0.13, 0.07, 0, 0.25, 0.19, c.pouch),
    box(0.09, 0.13, 0.07, 0.12, 0.25, 0.19, c.pouch),
    box(0.3, 0.045, 0.02, 0, 0.47, 0.172, c.red),                // red chest band
    box(0.3, 0.08, 0.27, 0, 0.6, -0.01, c.plate),                // collar
    box(0.17, 0.12, 0.22, 0.27, 0.52, 0, c.plate),               // shoulder armour
    box(0.17, 0.12, 0.22, -0.27, 0.52, 0, c.plate),
    box(0.18, 0.03, 0.23, 0.27, 0.595, 0, c.red),                // red pad tops
    box(0.18, 0.03, 0.23, -0.27, 0.595, 0, c.red),
    box(0.38, 0.42, 0.2, 0, 0.33, -0.3, c.pouch),                // backpack
    box(0.36, 0.09, 0.11, 0, 0.58, -0.27, c.strap),              // bedroll on top
    box(0.08, 0.14, 0.08, 0.22, 0.28, -0.3, c.suit),             // side pouch
    box(0.1, 0.1, 0.06, 0.12, 0.5, -0.36, c.metal),              // radio
    limb(0.14, 0.54, -0.37, 0.17, 1.08, -0.4, 0.01, c.metal, 0.6, 5),   // antenna
  ]);
  const chestGlow = merge([ball(0.02, 0.17, 1.09, -0.4, W)]);   // antenna tip
  const head = merge([
    ball(0.15, 0, 0.025, -0.01, c.armor, 1.0, 0.9, 1.08),        // helmet dome
    box(0.05, 0.15, 0.2, 0.15, -0.04, 0.0, c.armor),             // cheek / ear guards
    box(0.05, 0.15, 0.2, -0.15, -0.04, 0.0, c.armor),
    box(0.26, 0.04, 0.3, 0, -0.035, -0.02, c.plate),             // helmet rim
    box(0.16, 0.12, 0.1, 0, -0.085, 0.1, c.suit),                // respirator mask
    disc(0.032, 0.045, 0.065, -0.11, 0.155, c.metal),            // filters
    disc(0.032, 0.045, -0.065, -0.11, 0.155, c.metal),
    box(0.08, 0.05, 0.06, 0, 0.115, 0.125, c.metal),             // NVG mount
    box(0.032, 0.02, 0.28, 0, 0.162, -0.01, c.red),              // red crown stripe
  ]);
  const visor = box(0.25, 0.058, 0.04, 0, 0.022, 0.14, c.glow);
  const gunArms = merge([
    limb(0, 0, 0, 0.02, -0.16, 0.24, 0.05, c.suit),              // right upper arm
    limb(0.003, -0.024, 0.036, 0.0064, -0.051, 0.077, 0.054, c.red, 1),   // armband
    limb(0.02, -0.16, 0.24, -0.08, -0.2, 0.42, 0.046, c.armor),  // forearm → grip
    limb(-0.46, 0, 0, -0.3, -0.2, 0.3, 0.05, c.suit),            // left upper arm
    limb(-0.436, -0.03, 0.045, -0.412, -0.06, 0.09, 0.054, c.red, 1),
    limb(-0.3, -0.2, 0.3, -0.12, -0.22, 0.56, 0.046, c.armor),   // left forearm → foregrip
    box(0.07, 0.12, 0.66, -0.1, -0.16, 0.44, c.strap),           // rifle body
    box(0.065, 0.065, 0.36, -0.1, -0.13, 0.92, c.suit),          // suppressor (ends at the muzzle)
    box(0.05, 0.14, 0.08, -0.1, -0.27, 0.34, c.suit),            // grip
    box(0.07, 0.13, 0.2, -0.1, -0.2, 0.11, c.suit),              // stock
    box(0.045, 0.16, 0.07, -0.1, -0.3, 0.52, c.metal),           // magazine
    box(0.045, 0.06, 0.16, -0.1, -0.07, 0.56, c.armor),          // optic
    box(0.047, 0.03, 0.02, -0.1, -0.07, 0.645, c.red),           // optic cap
  ]);
  const thigh = merge([
    limb(0, 0, 0, 0, -THIGH, 0, 0.08, c.suit),
    box(0.14, 0.17, 0.08, 0, -0.19, 0.07, c.pouch),              // front thigh pouch
    box(0.17, 0.045, 0.17, 0, -0.1, 0, c.strap),                 // leg strap
  ]);
  const shin = merge([
    limb(0, 0, 0, 0, -SHIN, 0, 0.066, c.suit),
    box(0.14, 0.13, 0.07, 0, -0.03, 0.075, c.armor),             // knee pad
    box(0.15, 0.17, 0.16, 0, -SHIN + 0.09, 0.02, c.strap),       // boot
    box(0.15, 0.07, 0.3, 0, -SHIN + 0.035, 0.06, c.strap),       // sole / toe
  ]);
  return {
    pelvis, chest, head, visor, gunArms, thigh, shin, grenade: grenadeGeometry(),
    glow: { chest: chestGlow },
    chitin: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.55, metalness: 0.3, emissive: 0x000000 }),
    eye: eyeMaterial(c.glow, RAIDER_EYE_GLOW),
    grenadeMat: grenadeMaterial(),
    eyeGlow: RAIDER_EYE_GLOW,
  };
}
