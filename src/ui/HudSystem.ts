import type { GameContext, GameSystem } from '@/shared';
import { el, toggleClass } from './dom';
import { Reticle } from './hud/Reticle';
import { Vitals } from './hud/Vitals';
import { WeaponPanel } from './hud/WeaponPanel';
import { Compass } from './hud/Compass';
import { WorldMarkers } from './hud/WorldMarkers';
import { Objective, OBJECTIVE_TEXT } from './hud/Objective';
import { InteractionPrompt } from './hud/InteractionPrompt';
import { Notifications } from './hud/Notifications';
import { DamageOverlay } from './hud/DamageOverlay';
import { MissionInfo } from './hud/MissionInfo';
import { DeployOverlay } from './hud/DeployOverlay';
import { ScopeOverlay } from './hud/ScopeOverlay';
import { Pings } from './hud/Pings';
import { Squad } from './hud/Squad';
import { Nameplates } from './hud/Nameplates';
import { SpectateOverlay } from './hud/SpectateOverlay';
import { MapScreen } from './map/MapScreen';
import { TitleMenu } from './menus/TitleMenu';
import { LobbyMenu } from './menus/LobbyMenu';
import { PauseMenu } from './menus/PauseMenu';
import { DeathScreen } from './menus/DeathScreen';
import { MissionComplete } from './menus/MissionComplete';

/**
 * Arc Raiders-style HUD + menus. All DOM under `ctx.uiRoot`.
 * Gameplay HUD is visible only during gameplay phases and hidden while a menu blocker is active.
 * Multiplayer: a dead local player keeps the HUD (squad list, nameplates, pings, notifications) in a
 * `.spectating` state that hides the personal widgets (reticle, vitals, weapon, prompt).
 */
export class HudSystem implements GameSystem {
  readonly name = 'hud';
  private ctx!: GameContext;
  private hudRoot!: HTMLElement;
  private overlayRoot!: HTMLElement;

  private reticle!: Reticle;
  private vitals!: Vitals;
  private weapon!: WeaponPanel;
  private compass!: Compass;
  private markers!: WorldMarkers;
  private pings!: Pings;
  private squad!: Squad;
  private nameplates!: Nameplates;
  private spectate!: SpectateOverlay;
  private objective!: Objective;
  private prompt!: InteractionPrompt;
  private notifs!: Notifications;
  private damage!: DamageOverlay;
  private scope!: ScopeOverlay;
  private missionInfo!: MissionInfo;
  private deploy!: DeployOverlay;
  private map!: MapScreen;

  private title!: TitleMenu;
  private lobby!: LobbyMenu;
  private pause!: PauseMenu;
  private death!: DeathScreen;
  private complete!: MissionComplete;

  private unsubs: Array<() => void> = [];
  private hudVisible = true;
  private spectating = false;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // Layer order: full-screen overlays (vignette, scope) → HUD → deploy overlay → map → menus.
    this.overlayRoot = el('div', { cls: 'hud', parent: ctx.uiRoot });
    this.damage = new DamageOverlay(this.overlayRoot);
    this.scope = new ScopeOverlay(this.overlayRoot);

    this.hudRoot = el('div', { cls: 'hud', parent: ctx.uiRoot });
    this.markers = new WorldMarkers(this.hudRoot);
    this.nameplates = new Nameplates(this.hudRoot);
    this.pings = new Pings(this.hudRoot);
    this.reticle = new Reticle(this.hudRoot);
    this.vitals = new Vitals(this.hudRoot);
    this.weapon = new WeaponPanel(this.hudRoot);
    this.compass = new Compass(this.hudRoot);
    this.objective = new Objective(this.hudRoot);
    this.squad = new Squad(this.hudRoot);
    this.missionInfo = new MissionInfo(this.hudRoot);
    this.prompt = new InteractionPrompt(this.hudRoot);
    this.notifs = new Notifications(this.hudRoot);
    this.spectate = new SpectateOverlay(this.hudRoot);

    this.deploy = new DeployOverlay(ctx.uiRoot);
    this.map = new MapScreen(ctx.uiRoot);
    this.map.setPingSource(() => this.pings.getPings());

    this.title = new TitleMenu(ctx.uiRoot);
    this.lobby = new LobbyMenu(ctx.uiRoot);
    this.pause = new PauseMenu(ctx.uiRoot);
    this.death = new DeathScreen(ctx.uiRoot);
    this.complete = new MissionComplete(ctx.uiRoot);

    for (const c of [this.reticle, this.vitals, this.weapon, this.compass, this.markers, this.nameplates, this.pings, this.squad, this.objective, this.prompt, this.notifs, this.damage, this.scope, this.spectate, this.map]) c.bind(ctx);
    // Title before lobby: the lobby may emit `ui:lobbyToggled` (invite URL) which the title must already hear.
    for (const m of [this.title, this.lobby, this.pause, this.death, this.complete]) m.bind(ctx);

    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:phaseChanged', ({ phase }) => {
        this.deploy.setVisible(phase === 'deploying');
        switch (phase) {
          case 'playing': this.setObjective(OBJECTIVE_TEXT.find); break;
          case 'extracting': this.setObjective(OBJECTIVE_TEXT.countdown); break;
          case 'shipLanded': this.setObjective(OBJECTIVE_TEXT.board); break;
          case 'liftoff': this.setObjective(OBJECTIVE_TEXT.liftoff); break;
          default: break;
        }
      }),
      b.on('extraction:boarded', () => { if (ctx.phase === 'shipLanded') this.setObjective(OBJECTIVE_TEXT.liftoffSwitch); }),
      b.on('extraction:tick', ({ remaining }) => {
        if (ctx.phase !== 'extracting') return;
        // Keep the objective in sync with the timer (cheap: text only changes once a second).
        const m = Math.floor(remaining / 60), s = Math.floor(remaining % 60);
        this.objective.set(`함선 도착까지 ${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`, OBJECTIVE_TEXT.countdown.sub);
      }),
    );
    this.applyVisibility();
  }

  private setObjective(o: { text: string; sub: string }): void {
    this.ctx.bus.emit('ui:objective', { text: o.text, subText: o.sub });
  }

  update(dt: number, ctx: GameContext): void {
    this.applyVisibility();
    // Map polls M and draws itself while open (also handles its own blocker token).
    this.map.update(ctx);
    if (this.hudVisible) {
      this.reticle.update(dt, ctx);
      this.vitals.update(dt, ctx);
      this.weapon.update(dt);
      this.compass.update(ctx);
      this.missionInfo.update(ctx);
      this.pings.update(dt, ctx);
      this.squad.update(dt, ctx);
      this.spectate.update(dt, ctx);
    }
    this.scope.update(ctx);
    this.damage.update(dt, ctx);
    this.complete.update(dt);
    this.lobby.update(dt);
  }

  lateUpdate(_dt: number, ctx: GameContext): void {
    if (this.hudVisible) {
      this.markers.lateUpdate(ctx);
      this.pings.lateUpdate(ctx);
      this.nameplates.lateUpdate(ctx);
    }
  }

  /** Whether the tactical map is currently open (debug / other HUD parts). */
  get isMapOpen(): boolean { return this.map.isOpen; }

  private applyVisibility(): void {
    const ctx = this.ctx;
    const inGame = ctx.isGameplayPhase() || ctx.phase === 'deploying';
    const menuOpen = ctx.uiBlockers.has('menu');
    const dead = ctx.player?.isDead ?? false;
    // Multiplayer keeps the HUD up for a dead (spectating) player; solo hides it (death screen follows).
    const spectating = dead && ctx.isMultiplayer;
    const visible = inGame && !menuOpen && (!dead || spectating);
    if (visible !== this.hudVisible) {
      this.hudVisible = visible;
      toggleClass(this.hudRoot, 'hidden', !visible);
    }
    if (spectating !== this.spectating) {
      this.spectating = spectating;
      toggleClass(this.hudRoot, 'spectating', spectating);
    }
    const overlayVisible = inGame || ctx.phase === 'dead';
    toggleClass(this.overlayRoot, 'hidden', !overlayVisible);
    // Reticle hidden while inventory / any blocker is open (handled in Reticle.update via opacity).
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    for (const c of [this.reticle, this.vitals, this.weapon, this.compass, this.markers, this.nameplates, this.pings, this.squad, this.objective, this.prompt, this.notifs, this.damage, this.scope, this.spectate, this.missionInfo, this.deploy, this.map]) c.dispose();
    for (const m of [this.title, this.lobby, this.pause, this.death, this.complete]) m.dispose();
    this.hudRoot.remove(); this.overlayRoot.remove();
  }
}
