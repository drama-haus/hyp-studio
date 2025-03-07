import "./proxyTypes"
import { FollowPet } from "./pet"
import { SEND_RATE } from './gameObject'
app.configure([
  { key: 'target', label: 'Player Follow Target', type: 'text' },
  { key: 'avoidance_distance', label: 'Avoidance Distance', type: 'text', initial: '4' },
  { key: 'follow_speed', label: 'Follow Speed', type: 'text', initial: '2.2' },
  { key: 'rotation_speed', label: 'Rotation Speed', type: 'text', initial: '2.2' },
  { type: 'file', key: 'emote_idle', label: 'Idle Emote', kind: 'emote' },
  { type: 'file', key: 'emote_walking', label: 'Walking Emote', kind: 'emote' },
  { type: 'file', key: 'emote_sitting', label: 'Sitting Emote', kind: 'emote' }
]);


const followPet = new FollowPet(SEND_RATE);

