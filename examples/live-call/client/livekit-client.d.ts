// The few livekit-client types app.ts uses, so tsc can check it without installing the package. The browser loads
// the real library through the import map in index.html. With a bundler, `npm install livekit-client` and delete this.
declare module "livekit-client" {
  export enum RoomEvent {
    TrackSubscribed = "trackSubscribed",
    DataReceived = "dataReceived",
    Disconnected = "disconnected",
    AudioPlaybackStatusChanged = "audioPlaybackChanged",
  }
  export namespace Track {
    enum Kind {
      Audio = "audio",
      Video = "video",
    }
  }
  export interface RemoteTrack {
    kind: Track.Kind;
    attach(): HTMLMediaElement;
  }
  export interface RemoteAudioTrack extends RemoteTrack {
    setVolume(volume: number): void;
  }
  export class Room {
    readonly localParticipant: {
      readonly isMicrophoneEnabled: boolean;
      setMicrophoneEnabled(enabled: boolean): Promise<unknown>;
    };
    readonly canPlaybackAudio: boolean;
    connect(url: string, token: string): Promise<void>;
    disconnect(): Promise<void>;
    startAudio(): Promise<void>;
    on(event: RoomEvent.TrackSubscribed, listener: (track: RemoteTrack) => void): this;
    on(event: RoomEvent.DataReceived, listener: (payload: Uint8Array) => void): this;
    on(event: RoomEvent.Disconnected | RoomEvent.AudioPlaybackStatusChanged, listener: () => void): this;
  }
  export function createAudioAnalyser(track: RemoteAudioTrack): {
    calculateVolume(): number;
    cleanup(): Promise<void>;
  };
}
