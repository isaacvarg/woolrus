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
});
