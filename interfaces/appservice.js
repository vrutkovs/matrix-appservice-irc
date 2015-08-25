declare class AppService {
    constructor(config: Object): void;
    listen(port: number): void;
    on(event: string, fn: Function): void;
    setHomeserverToken(tok: string): void;
    onUserQuery: Function;
    onAliasQuery: Function;
}

declare class Request {
    id: string;
    defer: Object;
    log: Object;
    isFromIrc: boolean;
    start: number;
    errFn: Function;
    sucFn: Function;
    mxLib: Object;
    ircLib: Object;

    getPromise(): Object;
    getDuration(): number;
    reject(thing: any): void;
    resolve(thing: any): void;
}
