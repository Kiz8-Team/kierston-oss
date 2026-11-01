"""Intake: external extracts in, canonical assets out.

The one rule that makes this a subsystem rather than a folder — no stage
outside it opens a file a user downloaded. Everything downstream reads what
intake wrote into sim_data/, so the shape of a source file is known in exactly
one place.
"""
