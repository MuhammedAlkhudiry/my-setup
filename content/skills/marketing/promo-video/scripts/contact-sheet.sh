#!/bin/zsh
# Tile frames into one labelled image for review.
# usage: contact-sheet.sh <out.png> <columns> <frames...>
out=$1; cols=$2; shift 2
magick montage -font /System/Library/Fonts/Helvetica.ttc -pointsize 18 -fill '#ddd' -label '%t' "$@" -geometry 360x640+4+4 -tile ${cols}x -background '#222' $out
