import { EventEmitter } from 'node:events';
import type { AppEventType, AppEventPayload } from './events.js';
import { logger } from '../logger/index.js';

type Handler<T extends AppEventType> = (payload: AppEventPayload<T>) => void | Promise<void>;

class EventBus extends EventEmitter {
  override emit<T extends AppEventType>(type: T, payload: AppEventPayload<T>): boolean {
    logger.debug({ eventType: type }, 'EventBus emit');
    return super.emit(type, payload);
  }

  override on<T extends AppEventType>(type: T, handler: Handler<T>): this {
    return super.on(type, handler);
  }

  override once<T extends AppEventType>(type: T, handler: Handler<T>): this {
    return super.once(type, handler);
  }

  override off<T extends AppEventType>(type: T, handler: Handler<T>): this {
    return super.off(type, handler);
  }
}

// Singleton — imported directly by services, plugins, and schedulers
export const eventBus = new EventBus();
export type { AppEventType, AppEventPayload, Handler };
export type { AppEvent } from './events.js';
