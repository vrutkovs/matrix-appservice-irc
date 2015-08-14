declare class AppService {
    constructor(config: Object): void;
    listen(port: number): void;
    on(event: string, fn: Function): void;
    setHomeserverToken(tok: string): void;
    onUserQuery: Function;
    onAliasQuery: Function;
}