import type { Collection } from 'mongodb';
import { eventBus } from '../../core/event-bus/index.js';
import { getDb } from '../../core/database/client.js';
import { logger } from '../../core/logger/index.js';
import type { PlayerSessionDocument } from './players.types.js';

class SessionRecorder {
  private collection?: Collection<PlayerSessionDocument>;
  private listening = false;

  async start(): Promise<void> {
    const db = getDb();
    this.collection = db.collection<PlayerSessionDocument>('player_sessions');

    await this.collection.createIndex({ username: 1, leftAt: 1 });
    await this.collection.createIndex({ joinedAt: 1 });
    await this.collection.createIndex({ server: 1, joinedAt: 1 });

    await this.cleanupOrphans();

    this.listening = true;
    eventBus.on('player.joined', this.onJoined);
    eventBus.on('player.left', this.onLeft);
    eventBus.on('player.server.changed', this.onServerChanged);
    logger.info('Session recorder started');
  }

  stop(): void {
    this.listening = false;
    eventBus.off('player.joined', this.onJoined);
    eventBus.off('player.left', this.onLeft);
    eventBus.off('player.server.changed', this.onServerChanged);
    logger.info('Session recorder stopped');
  }

  private onJoined = (payload: { username: string; server: string }): void => {
    if (!this.listening) return;
    void this.openSession(payload.username, payload.server);
  };

  private onLeft = (payload: { username: string; server: string }): void => {
    if (!this.listening) return;
    void this.closeSession(payload.username, payload.server, 'left');
  };

  private onServerChanged = (payload: { username: string; previousServer: string; currentServer: string }): void => {
    if (!this.listening) return;
    void this.handleServerChange(payload);
  };

  private async openSession(username: string, server: string): Promise<void> {
    try {
      await this.collection!.insertOne({
        username,
        server,
        joinedAt: new Date(),
        leftAt: null,
        duration: null,
        closedReason: null,
      });
    } catch (err) {
      logger.error({ err, username, server }, 'Failed to open session');
    }
  }

  private async closeSession(username: string, server: string, reason: 'left' | 'server_change'): Promise<void> {
    try {
      const now = new Date();
      await this.collection!.findOneAndUpdate(
        { username, server, leftAt: null },
        [
          {
            $set: {
              leftAt: now,
              closedReason: reason,
              duration: { $subtract: [now, '$joinedAt'] },
            },
          },
        ],
      );
    } catch (err) {
      logger.error({ err, username, server }, 'Failed to close session');
    }
  }

  private async handleServerChange(payload: { username: string; previousServer: string; currentServer: string }): Promise<void> {
    await this.closeSession(payload.username, payload.previousServer, 'server_change');
    await this.openSession(payload.username, payload.currentServer);
  }

  private async cleanupOrphans(): Promise<void> {
    const now = new Date();
    const result = await this.collection!.updateMany(
      { leftAt: null },
      [
        {
          $set: {
            leftAt: now,
            closedReason: 'orphan_cleanup' as const,
            duration: { $subtract: [now, '$joinedAt'] },
          },
        },
      ],
    );
    if (result.modifiedCount > 0) {
      logger.info({ count: result.modifiedCount }, 'Cleaned up orphaned sessions');
    }
  }
}

export const sessionRecorder = new SessionRecorder();
