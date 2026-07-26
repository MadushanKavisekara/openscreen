# NixOS module for Screenly
# Usage in flake-based NixOS config:
#
#   inputs.screenly.url = "github:MadushanKavisekara/screenly";
#
#   { inputs, ... }: {
#     imports = [ inputs.screenly.nixosModules.default ];
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
    environment.systemPackages = [ cfg.package ];

    # Screen capture on Wayland requires xdg-desktop-portal.
    # We enable the base portal; users should also enable a
    # desktop-specific portal (e.g. xdg-desktop-portal-gtk,
    # xdg-desktop-portal-hyprland) in their DE config.
    xdg.portal.enable = lib.mkDefault true;
  };
}
