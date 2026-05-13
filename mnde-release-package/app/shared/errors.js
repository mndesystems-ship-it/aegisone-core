export class FailClosedError extends Error {
    layer;
    code;
    constructor(layer, code, message){
        super(message);
        this.name = "FailClosedError";
        this.layer = layer;
        this.code = code;
    }
}
