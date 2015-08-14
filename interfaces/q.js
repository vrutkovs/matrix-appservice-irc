declare class QPromise<R> {
    constructor(callback: (
      resolve: (result: Promise<R> | R) => void,
      reject:  (error: any) => void
    ) => void): void;

    then<U>(
      onFulfill?: (value: R) => Promise<U> | U,
      onReject?: (error: any) => Promise<U> | U
    ): Promise<U>;

    catch<U>(
      onReject?: (error: any) => ?Promise<U> | U
    ): Promise<U>;

    static resolve<T>(object?: Promise<T> | T): Promise<T>;
    static reject<T>(error?: any): Promise<T>;
    static all<T>(promises: Array<Promise<T>>): Promise<Array<T>>;
    static race<T>(promises: Array<Promise<T>>): Promise<T>;

    // Non-standard APIs common in some libraries

    done<U>(
      onFulfill?: (value: R) => void,
      onReject?: (error: any) => void
    ): void;

    finally<U>(
      onFulfill?: (value: R) => void,
      onReject?: (error: any) => void
    ): void;

    static cast<T>(object?: T): Promise<T>;
}