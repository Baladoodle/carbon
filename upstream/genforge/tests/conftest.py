import urllib.request

import pytest


@pytest.fixture(autouse=True)
def forbid_provider_network(monkeypatch):
    def unexpected(*args, **kwargs):
        pytest.fail("Tests must inject a fake image transport; provider network access is forbidden")
    monkeypatch.setattr(urllib.request, "urlopen", unexpected)
