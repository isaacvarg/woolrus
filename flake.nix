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
        env = prisma.env;

        packages = with pkgs; [
          openssl
          pkg-config
        ];
      };
    };
}
