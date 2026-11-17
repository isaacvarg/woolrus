{
  description = "Woolrus development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    prisma-utils.url = "github:VanCoding/nix-prisma-utils";
  };

  outputs = { nixpkgs, prisma-utils, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};

      prisma = prisma-utils.lib.prisma-factory {
        inherit pkgs;

        version = {
          majorVersion = 7;
          commit = "0edf323efd1d98336f3f0a68684b56f689b900d3";
        };

        hash = "sha256-TbZOMYj7WbVhuZUem6zNzQjfCnH0zngyWhUtHriEqvY=";
      };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        env = prisma.env // {
          # Playwright's downloaded browsers don't run on NixOS; use nixpkgs' build instead. Its
          # version must match @playwright/test in apps/web/package.json (both 1.64.1).
          PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
        };

        packages = with pkgs; [
          openssl
          pkg-config
        ];
      };
    };
}
