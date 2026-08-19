declare module "utif" {
  const UTIF: {
    decode(data: ArrayBuffer | Uint8Array): any[];
    decodeImage(data: ArrayBuffer | Uint8Array, image: any): void;
    toRGBA8(image: any): Uint8Array;
  };

  export default UTIF;
}
