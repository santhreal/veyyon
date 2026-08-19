#!/usr/bin/env bash
# What the camera sees, before a take is spent on it. No model turn: the app is launched,
# the composer is shown, one surface is opened, and each frame is a full-resolution
# screenshot of the chrome the recording would use. Costs about ninety seconds, which is
# cheaper than judging a twenty-minute take after the fact.
settle 12
shot idle

submit "/secret"
settle 6
shot secret-surface
k Escape
sleep 1

submit "/settings"
settle 5
shot settings
glide 12 40 24 40 24 0.06
sleep 0.6
shot settings-hover
k Escape
sleep 1
shot closed
