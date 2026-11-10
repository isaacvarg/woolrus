import { describe, expect, it } from "vitest";
import { renderEmail } from "./emails";

describe("renderEmail", () => {
  it("renders the invitation with the inviter, the roles and a sign-in link", () => {
    const url = "https://woolrus.example/sign-in?email=ana%40example.com";
    const email = renderEmail(
      "invitation",
      { inviter: "Isa <Admin>", roles: "Picker, Packer", url },
      "en",
    );

    expect(email.subject).toBe("Isa <Admin> invited you to Woolrus");
    expect(email.text).toContain("Isa <Admin> invited you to Woolrus");
    expect(email.text).toContain(`Sign in to Woolrus: ${url}`);
    expect(email.html).toContain("Isa &lt;Admin&gt; invited you");
    expect(email.html).toContain(`<a href="${url}">Sign in to Woolrus</a>`);
    expect(email.html).toContain("as Picker, Packer.");
  });

  it("renders accountEnabled with the admin and a sign-in link, and no expiry", () => {
    const url = "https://woolrus.example/sign-in?email=luis%40example.com";
    const email = renderEmail("accountEnabled", { admin: "Isa <Admin>", url }, "en");

    expect(email.subject).toBe("Isa <Admin> set up sign-in for you");
    expect(email.text).toContain(`Sign in to Woolrus: ${url}`);
    expect(email.html).toContain("Isa &lt;Admin&gt; set up");
    expect(email.html).toContain(`<a href="${url}">Sign in to Woolrus</a>`);
    expect(email.text).not.toMatch(/valid for|expires/i);
  });
});
