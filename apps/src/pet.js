// FollowPet.js

import { GameObject, SEND_RATE } from './gameObject';

// -------------------------------------------------------------------
// CONSTANTS & GLOBALS (for follow logic)
// -------------------------------------------------------------------
const NUM_RAYS = 5;                   // Number of rays for collision avoidance
const FOV_ANGLE = Math.PI / 4;          // 45° field of view for raycasting
const BASE_DIRECTION = new Vector3(0, 0, -1); // Default forward direction

const STOP_THRESHOLD = 3;
const MAX_PLAYER_DISTANCE = 100.0;
const STUCK_CHECK_INTERVAL = 2.0;
const STUCK_THRESHOLD = 0.2;
const STUCK_LIMIT = 3;

// -------------------------------------------------------------------
// FollowPet Class Definition
// -------------------------------------------------------------------
export class FollowPet extends GameObject {
  constructor(sendRate = SEND_RATE) {
    // No root passed; GameObject creates its own root (a WorldObject) downstream.
    super(sendRate, false);

    // Read configuration values from props.
    this.followSpeed = Number.parseFloat(props.follow_speed) || 2.2;
    this.avoidanceDistance = Number.parseFloat(props.avoidance_distance) || 4;
    this.rotationSpeed = Number.parseFloat(props.rotation_speed) || 2.2;

    this.idleEmote = props.emote_idle?.url;
    this.walkEmote = props.emote_walking?.url;
    this.sitEmote = props.emote_sitting?.url;
    this.targetId = props.target; // (if used)

    if (!this.targetId && !this.ownerId) {
      this.emote = this.sitEmote;
    }

    // Variables for interaction UI and adoption actions.
    this.action = null;
    this.worldUI = null;

    // Stuck detection.
    this.lastCheckTime = 0;
    this.stuckCounter = 0;
    this.lastPosition = new Vector3().copy(this.root.position);
    

    // Temporary vectors for calculations.
    this._direction = new Vector3();
    this._forward = new Vector3();
    this._velocity = new Vector3();


    if (world.isServer) {
      this.setPetState();

      this.addEventListener('fixedUpdate', (delta) => this.fixedUpdateServer(delta));
      this.addEventListener('requestAdoption', (playerId) => this.adoptionRequest(playerId));
      this.addEventListener('leave', (e) => this.playerLeftLobby(e), false);
      this.addEventListener('setPlayer', (player) => this.setPlayer(player));
    } else {
      if (app.state.ready) {
        this.initState(app.state);
      }

      this.addEventListener('updateStatePlayer', (state) => this.initState(state));
      this.addEventListener('updateState', (state) => this.initState(state));
      this.addEventListener('leave', (event) => this.playerLeftLobby(e), false);
      this.addEventListener('fixedUpdate', (delta) => this.updatePetClient(delta));
      this.addEventListener('objectMove', (event) => this.objectMoveEvent(event));
      this.onOwnershipChanged = this.changeOwnership;
    }

    this.sendState();
  }

  // --- Interaction UI ---
  interactWithPet() { }

  changeOwnership(oldOwner, newOwner) {
    if (!newOwner) {
      this.root.avatar?.setEmote(this.sitEmote);
    }
  }

  playerLeftLobby(e) {
    if (world.isClient) {
      this.emote = this.sitEmote;
      this.root.avatar.setEmote(this.sitEmote);
    } 
    console.log('player left lobby');
    if (e.player.networkId === this.ownerId) {
      ownerId = null;
      this.emote = this.sitEmote;
      this.setState('emote', this.sitEmote);
      this.take(null);
    }
  }

  objectMoveEvent(event) {
    if (world.isServer && !this.ownerId) {
      this.emote = this.sitEmote;
      this.setState('emote', this.sitEmote);
      return;
    }

    if (this.ownerId === world.networkId) { return; }
    this.root.avatar?.setEmote(event.emote);
  }

  setPlayer(player) {
    this.setState('player', player, true);
  }

  adoptionRequest(playerId) {
    if (!world.isServer) { return; } // cannot execute as client
    let current_id = this.state.get('player_id');

    if (current_id) { return; } // can't adopt already owned

    props.target = playerId;
    this.setState('props', props);
    this.setState('player_id', playerId);
    this.setState('player', null);

    this.sendState();
  }

  setPetState() {
    this.setState('player_id', this.targetId ? this.targetId : null);
    this.setState('player', null);
  }

  initState(state) {
    if (!(state instanceof Map)) {
      state = new Map(Object.entries(state));
    }
    // Use full property names from state.
    this.root.position.fromArray(state.get("position"));
    this.root.quaternion.fromArray(state.get("quaternion"));
    this.ownerId = state.get('ownerId') || null;
    // Update global props if needed.
    props = state.get("props");

    const local_player = world.getPlayer();
    let player = state.get("player");
    let player_id = state.get("player_id");

    if (this.action) {
      app.remove(this.action);
      this.action = null;
    }
    // If no player object is provided, try to look it up.
    if (!player && player_id === local_player.id) {
      player = world.getPlayer();
    }
    // If the local player is the target, claim ownership and add an "Interact" action.
    if (player && player.id === local_player.id) {
      this.take(player.networkId);
      this.action = app.create('action', {
        label: 'Interact',
        distance: 2,
        onTrigger: () => { this.interactWithPet(); }
      });
      app.add(this.action);
    }
    // If no target is defined, add an "Adopt" action.
    if (!props.target) {
      this.root.avatar.setEmote(this.sitEmote);
      this.action = app.create('action', {
        label: 'Adopt',
        distance: 2,
        onTrigger: () => {
          app.send('requestAdoption', local_player.id);
        }
      });
      app.add(this.action);
    }
    // Note: The GameObject base already listens for "updateState" events.
  }

  // --- Client-side Update ---
  updatePetClient(delta) {
    // If no one owns the pet, have it sit and let GameObject handle interpolation.
    if (!this.ownerId) {
      this.root.avatar.setEmote(this.sitEmote);
      super.updateClient(delta);
      return;
    }

    // If the local client owns the pet, run follow logic.
    if (this.ownerId === world.networkId) {
      if (app.sleeping) {
        if (this.root.avatar && typeof this.root.avatar.setEmote === 'function') {
          this.root.avatar.setEmote(this.idleEmote);
          this.setState('emote', this.idleEmote);
        }
        return;
      }
      const player = world.getPlayer();
      if (!player) return;

      const currentPos = this.root.position;
      const targetPos = player.position;

      // Calculate horizontal direction toward the target.
      this._direction.copy(targetPos).sub(currentPos);
      this._direction.y = 0;
      let distanceToTarget = this._direction.length();
      let atTarget = false;

      if (distanceToTarget <= STOP_THRESHOLD) {
        atTarget = true;
        if (this.root.avatar && typeof this.root.avatar.setEmote === 'function') {
          this.root.avatar.setEmote(this.idleEmote);
          this.setState('emote', this.idleEmote);
        }
        this._direction.set(0, 0, 0);
      } else if (distanceToTarget >= MAX_PLAYER_DISTANCE) {
        console.log("Player too far; teleporting pet.");
        this.root.position.copy(targetPos);
        return;
      }

      // Collision avoidance via raycasting.
      const rayStart = new Vector3().copy(currentPos);
      rayStart.y = Math.max(rayStart.y, 1.0);
      const centerRayClear = !world.raycast(rayStart, this._direction, this.avoidanceDistance, null);

      if (centerRayClear) {
        if (!atTarget) {
          const moveVector = new Vector3().copy(this._direction).multiplyScalar(this.followSpeed);
          this.root.position.lerp(currentPos.clone().add(moveVector.multiplyScalar(delta)), 0.1);
          if (this._direction.lengthSq() > 0.0001) {
            this._direction.normalize();
            const movementQuat = new Quaternion().setFromUnitVectors(BASE_DIRECTION, this._direction);
            this.root.quaternion.slerp(movementQuat, 0.08);
          }
        }
      } else {
        // Multi-ray avoidance.
        let avoidanceVector = new Vector3();
        let hitDetected = false;
        let closestHitDistance = Infinity;
        let obstacleNormal = new Vector3();

        for (let i = 0; i < NUM_RAYS; i++) {
          const angleOffset = (i / (NUM_RAYS - 1) - 0.5) * FOV_ANGLE;
          const rayDirection = new Vector3().copy(this._direction);
          rayDirection.applyAxisAngle(new Vector3(0, 1, 0), angleOffset);
          rayDirection.normalize();

          const hit = world.raycast(rayStart, rayDirection, this.avoidanceDistance, null);
          if (hit) {
            // Skip if the hit belongs to the target.
            if (hit.player && hit.player.id === props.target) continue;
            if (hit.distance < closestHitDistance) {
              closestHitDistance = hit.distance;
              obstacleNormal.copy(hit.normal);
            }
            avoidanceVector.add(rayDirection);
            hitDetected = true;
          }
        }

        if (hitDetected) {
          avoidanceVector.normalize();
          let sidestepDirection = new Vector3();
          sidestepDirection.crossVectors(this._direction, new Vector3(0, 1, 0));
          if (sidestepDirection.dot(obstacleNormal) < 0) {
            sidestepDirection.negate();
          }
          let sidestepClear = !world.raycast(rayStart, sidestepDirection, this.avoidanceDistance, null);
          if (!sidestepClear) {
            sidestepDirection.negate();
            sidestepClear = !world.raycast(rayStart, sidestepDirection, this.avoidanceDistance, null);
          }
          if (sidestepClear) {
            avoidanceVector.copy(sidestepDirection);
          } else {
            avoidanceVector.set(0, 0, 0);
          }
        } else {
          avoidanceVector.copy(this._direction);
        }

        if (avoidanceVector.lengthSq() > 0.0001) {
          const moveVector = new Vector3().copy(avoidanceVector).multiplyScalar(this.followSpeed);
          this.root.position.lerp(currentPos.clone().add(moveVector.multiplyScalar(delta)), 0.1);
          avoidanceVector.normalize();
          this._direction.normalize();
          const movementQuat = new Quaternion().setFromUnitVectors(BASE_DIRECTION, avoidanceVector);
          const targetQuat = new Quaternion().setFromUnitVectors(BASE_DIRECTION, this._direction);
          const blendedQuat = new Quaternion();
          blendedQuat.slerpQuaternions(movementQuat, targetQuat, 0.3);
          this.root.quaternion.slerp(blendedQuat, 0.08);
          if (this.root.avatar && typeof this.root.avatar.setEmote === 'function') {
            this.root.avatar.setEmote(this.walkEmote);
            this.setState('emote', this.walkEmote);
          }
        }
      }

      // Stuck detection: if the pet hasn't moved enough over a period, teleport it to the player.
      this.lastCheckTime += delta;
      if (this.lastCheckTime >= STUCK_CHECK_INTERVAL && !atTarget) {
        this.lastCheckTime = 0;
        const movementDistance = this.lastPosition.distanceTo(currentPos);
        console.log("Movement distance:", movementDistance);
        if (movementDistance < STUCK_THRESHOLD) {
          this.stuckCounter++;
          if (this.stuckCounter >= STUCK_LIMIT) {
            console.log("[STUCK] Teleporting pet to player.");
            this.root.position.copy(targetPos);
            this.stuckCounter = 0;
          }
        } else {
          this.stuckCounter = 0;
        }
        this.lastPosition.copy(currentPos);
      }

      // Update state using setState so that the updateState event is used.
      this.setState('position', currentPos.toArray());
      this.setState('quaternion', this.root.quaternion.toArray());

      // Let the GameObject base handle further event processing.
      super.updateClient(delta);
    } else {
      super.updateClient(delta);
    }
  }

}
