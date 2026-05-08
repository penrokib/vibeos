import "reflect-metadata";
import { IS_PUBLIC_KEY, Public } from "./public.decorator";

describe("@Public decorator", () => {
  it("uses the documented metadata key", () => {
    expect(IS_PUBLIC_KEY).toBe("isPublic");
  });

  it("attaches isPublic=true metadata to the target", () => {
    class Sample {
      @Public()
      handler(): void {}
    }
    const meta = Reflect.getMetadata(IS_PUBLIC_KEY, Sample.prototype.handler);
    expect(meta).toBe(true);
  });
});
