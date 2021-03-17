import {
  AggregatedSessions,
  AggregationCounts,
  Session as SessionInterface,
  SessionAttributes,
  SessionContext,
  SessionFlusher as SessionFlusherInterface,
  SessionMode,
  SessionStatus,
  Transport,
} from '@sentry/types';
import { dropUndefinedKeys, logger, uuid4 } from '@sentry/utils';

/**
 * @inheritdoc
 */
export class Session implements SessionInterface {
  public userAgent?: string;
  public errors: number = 0;
  public release?: string;
  public sid: string = uuid4();
  public did?: string;
  public timestamp: number = Date.now();
  public started: number = Date.now();
  public duration: number = 0;
  public status: SessionStatus = SessionStatus.Ok;
  public sessionMode: SessionMode = SessionMode.Application;
  public environment?: string;
  public ipAddress?: string;
  public init: boolean = true;

  constructor(context?: Omit<SessionContext, 'started' | 'status'>) {
    if (context) {
      this.update(context);
    }
  }

  /** JSDoc */
  // eslint-disable-next-line complexity
  update(context: SessionContext = {}): void {
    if (context.user) {
      if (context.user.ip_address) {
        this.ipAddress = context.user.ip_address;
      }

      if (!context.did) {
        this.did = context.user.id || context.user.email || context.user.username;
      }
    }

    this.timestamp = context.timestamp || Date.now();

    if (context.sid) {
      // Good enough uuid validation. — Kamil
      this.sid = context.sid.length === 32 ? context.sid : uuid4();
    }
    if (context.init !== undefined) {
      this.init = context.init;
    }
    if (context.did) {
      this.did = `${context.did}`;
    }
    if (typeof context.started === 'number') {
      this.started = context.started;
    }
    if (typeof context.duration === 'number') {
      this.duration = context.duration;
    } else {
      this.duration = this.timestamp - this.started;
    }
    if (context.release) {
      this.release = context.release;
    }
    if (context.environment) {
      this.environment = context.environment;
    }
    if (context.ipAddress) {
      this.ipAddress = context.ipAddress;
    }
    if (context.userAgent) {
      this.userAgent = context.userAgent;
    }
    if (typeof context.errors === 'number') {
      this.errors = context.errors;
    }
    if (context.status) {
      this.status = context.status;
    }
    if (context.sessionMode) {
      this.sessionMode = context.sessionMode;
    }
  }

  /** JSDoc */
  close(status?: Exclude<SessionStatus, SessionStatus.Ok>): void {
    if (status) {
      this.update({ status });
    } else if (this.status === SessionStatus.Ok) {
      this.update({ status: SessionStatus.Exited });
    } else {
      this.update();
    }
  }

  /** JSDoc */
  getSessionAttributes(withUserInfo: boolean = true): SessionAttributes {
    const attrs: SessionAttributes = {};
    if (this.release !== undefined) {
      attrs.release = this.release;
    }
    if (this.environment !== undefined) {
      attrs.environment = this.environment;
    }
    if (withUserInfo) {
      if (this.ipAddress !== undefined) {
        attrs.ipAddress = this.ipAddress;
      }
      if (this.userAgent !== undefined) {
        attrs.userAgent = this.userAgent;
      }
    }
    return attrs;
  }

  /** JSDoc */
  toJSON(): {
    init: boolean;
    sid: string;
    did?: string;
    timestamp: string;
    started: string;
    duration: number;
    status: SessionStatus;
    session_mode: SessionMode;
    errors: number;
    attrs?: {
      release?: string;
      environment?: string;
      user_agent?: string;
      ip_address?: string;
    };
  } {
    return dropUndefinedKeys({
      sid: `${this.sid}`,
      init: this.init,
      started: new Date(this.started).toISOString(),
      timestamp: new Date(this.timestamp).toISOString(),
      status: this.status,
      session_mode: this.sessionMode,
      errors: this.errors,
      did: typeof this.did === 'number' || typeof this.did === 'string' ? `${this.did}` : undefined,
      duration: this.duration,
      attrs: dropUndefinedKeys({
        release: this.release,
        environment: this.environment,
        ip_address: this.ipAddress,
        user_agent: this.userAgent,
      }),
    });
  }
}

/**
 * @inheritdoc
 */
export class SessionFlusher implements SessionFlusherInterface {
  private _pendingAggregates: { [key: number]: AggregationCounts } = {};
  private _sessionAttrs: SessionAttributes | undefined;
  private _intervalId: any;

  constructor(private _transport: Transport, public readonly flushTimeout: number = 10) {
    this._intervalId = setInterval(this.flush.bind(this), this.flushTimeout * 1000);
  }

  /** JSDoc */
  public sendSessions(aggregatedSession: AggregatedSessions): void {
    if (!this._transport.sendSessions) {
      logger.warn("Dropping session because custom transport doesn't implement sendSession");
      return;
    }
    this._transport.sendSessions(aggregatedSession).then(null, reason => {
      logger.error(`Error while sending session: ${reason}`);
    });
  }

  /** JSDoc */
  flush(): void {
    if (Object.keys(this._pendingAggregates).length === 0) {
      return;
    }
    const aggregates: AggregationCounts[] = Object.keys(this._pendingAggregates).map((key: string) => {
      return this._pendingAggregates[parseInt(key)];
    });
    this._pendingAggregates = {};
    const aggregatedSessions: AggregatedSessions = {
      attrs: this._sessionAttrs,
      aggregates: aggregates,
    };
    this._sessionAttrs = undefined;
    this.sendSessions(aggregatedSessions);
  }

  /** JSDoc */
  close(): void {
    clearTimeout(this._intervalId);
    this.flush();
  }

  /** JSDoc */
  addSession(session: Session): void {
    // If Session attrs don't already exist in the pendingAggregates buffer, then set them from the Session passed
    if (!this._sessionAttrs) {
      this._sessionAttrs = session.getSessionAttributes(false);
    }

    // Truncate minutes and seconds on Session Started attribute to have one minute bucket keys
    const sessionStartedTrunc: number = new Date(session.started).setMinutes(0, 0, 0);

    this._pendingAggregates[sessionStartedTrunc] = this._pendingAggregates[sessionStartedTrunc] || {};

    // corresponds to aggregated sessions in one specific minute bucket
    // for example, {"started":"2021-03-16T08:00:00.000Z","exited":4, "errored": 1}
    const aggregationCounts: AggregationCounts = this._pendingAggregates[sessionStartedTrunc];

    if (!aggregationCounts.started) {
      aggregationCounts.started = new Date(sessionStartedTrunc).toISOString();
    }
    if (session.status == SessionStatus.Crashed) {
      aggregationCounts.crashed = aggregationCounts.crashed !== undefined ? aggregationCounts.crashed + 1 : 1;
    } else if (session.status == SessionStatus.Abnormal) {
      aggregationCounts.abnormal = aggregationCounts.abnormal !== undefined ? aggregationCounts.abnormal + 1 : 1;
    } else if (session.errors > 0) {
      aggregationCounts.errored = aggregationCounts.errored !== undefined ? aggregationCounts.errored + 1 : 1;
    } else {
      logger.log(session.status);
      aggregationCounts.exited = aggregationCounts.exited !== undefined ? aggregationCounts.exited + 1 : 1;
    }
  }
}
