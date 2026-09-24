import { expect, test } from "bun:test";
import { getAllowedAttachments } from "./utils";

const attachment = (Name: string, ContentType: string) => ({
  ContentLength: 51899,
  Name,
  ContentType,
  ContentID: "",
  Content: "",
});

test("passes only supported invoice inputs on to intake", () => {
  const allowed = getAllowedAttachments([
    attachment("DigitalOcean Invoice 2023 Apr (33-11).pdf", "application/pdf"),
    attachment("Photo.jpg", "image/jpeg"),
    attachment("Scan.png", "image/png"),
    attachment("IMG_0042.HEIC", "image/heic"),
    attachment("photo.webp", "image/webp"),
    attachment("ergerwed", "application/pgp-keys"),
    attachment("wedwed", "application/pgp-signature"),
  ]);

  expect(allowed?.map(({ Name }) => Name)).toEqual([
    "DigitalOcean Invoice 2023 Apr (33-11).pdf",
    "Photo.jpg",
    "Scan.png",
  ]);
});
