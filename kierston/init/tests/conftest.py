"""Put the pipeline's own directories on sys.path, the way its scripts do.

The stages import one another by bare name (`import registries`,
`from paths import PROFILE`) after a sys.path insert of their own; the tests
reproduce that rather than turning init/ into a package.
"""

import sys
from pathlib import Path

INIT = Path(__file__).resolve().parents[1]
for directory in (INIT / "criminal_history", INIT / "personal_records", INIT):
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))
