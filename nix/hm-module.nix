# Home Manager module for Screenly
# Usage in flake-based Home Manager config:
#
#   inputs.screenly.url = "github:MadushanKavisekara/screenly";
#
#   { inputs, ... }: {
#     imports = [ inputs.screenly.homeManagerModules.default ];
#     programs.screenly.enable = true;
#   }
self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.screenly;
in
{
  options.programs.screenly = {
    enable = lib.mkEnableOption "Screenly screen recorder";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.screenly;
      defaultText = lib.literalExpression "inputs.screenly.packages.\${pkgs.stdenv.hostPlatform.system}.screenly";
      description = "The Screenly package to use.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
  };
}
