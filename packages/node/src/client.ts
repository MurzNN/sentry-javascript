import { BaseClient, Scope } from '@sentry/core';
import { Session, SessionFlusher } from '@sentry/hub';
import { Event, EventHint, SessionMode } from '@sentry/types';
import { logger } from '@sentry/utils';

import { NodeBackend, NodeOptions } from './backend';

/**
 * The Sentry Node SDK Client.
 *
 * @see NodeOptions for documentation on configuration options.
 * @see SentryClient for usage documentation.
 */
export class NodeClient extends BaseClient<NodeBackend, NodeOptions> {
  protected _sessionFlusher: SessionFlusher | undefined;
  /**
   * Creates a new Node SDK instance.
   * @param options Configuration options for this SDK.
   */
  public constructor(options: NodeOptions) {
    super(NodeBackend, options);
    if (options.autoSessionTracking || options.autoSessionTracking === undefined) {
      // ToDo check if this would actually work prior to lazy intializing the transport and find better way to initialize
      // flush timeout
      this._sessionFlusher = new SessionFlusher(this._backend.getTransport());
    }
  }
  /**
   * @inheritDoc
   */
  public captureSession(session: Session): void {
    if (!session.release) {
      logger.warn('Discarded session because of missing release');
    } else {
      if (session.sessionMode === SessionMode.Application) {
        this._sendSession(session);
        // After sending, we set init false to inidcate it's not the first occurence
        session.update({ init: false });
      } else {
        if (!this._sessionFlusher) {
          logger.warn('Discarded request mode session because autosessionTracking option was disabled');
        } else {
          this._sessionFlusher.addSession(session);
          // ToDo check if session needs to be updated
        }
      }
    }
  }

  /**
   * @inheritDoc
   */
  protected _prepareEvent(event: Event, scope?: Scope, hint?: EventHint): PromiseLike<Event | null> {
    event.platform = event.platform || 'node';
    if (this.getOptions().serverName) {
      event.server_name = this.getOptions().serverName;
    }
    return super._prepareEvent(event, scope, hint);
  }
}
